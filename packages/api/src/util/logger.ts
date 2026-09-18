import Debug from 'debug';
import * as productionSink from './logger-sink';
import { getRequestScope } from './request-scope';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export type LogData = Readonly<Record<string, unknown>>;

export interface LogRecord {
  readonly timestamp: string;
  readonly level: LogLevel;
  readonly namespace: string;
  readonly message: string;
  readonly requestId?: string;
  readonly data?: LogData;
}

export interface LogLevelParseResult {
  readonly level: LogLevel;
  readonly invalidValue?: string;
}

export interface Logger {
  debug(message: string, data?: LogData): void;
  info(message: string, data?: LogData): void;
  warn(message: string, data?: LogData): void;
  error(message: string, error: unknown, data?: LogData): void;
}

const SEVERITY: Readonly<Record<LogLevel, number>> = { debug: 0, info: 1, warn: 2, error: 3 };

// Space, tab, CR, LF, FF, VT — deliberately NOT `\s`, which in a JS RegExp
// also matches non-ASCII whitespace such as U+00A0 (non-breaking space).
// Accepting that here would silently admit an NBSP-padded value that
// operators cannot distinguish from a typo (brief §9).
const ASCII_WHITESPACE_EDGES = /^[ \t\r\n\f\v]+|[ \t\r\n\f\v]+$/g;

const isLogLevel = (value: string): value is LogLevel => value === 'debug' || value === 'info' || value === 'warn' || value === 'error';

export const parseLogLevel = (value: string | undefined): LogLevelParseResult => {
  if (value === undefined) return { level: 'info' };
  const trimmed = value.replace(ASCII_WHITESPACE_EDGES, '');
  if (trimmed === '') return { level: 'info' };
  const lower = trimmed.toLowerCase();
  if (isLogLevel(lower)) return { level: lower };
  return { level: 'info', invalidValue: value };
};

export const createLogRecord = (level: LogLevel, namespace: string, message: string, data?: LogData): LogRecord => {
  const scope = getRequestScope();
  return {
    timestamp: new Date().toISOString(),
    level,
    namespace,
    message,
    ...(scope !== undefined ? { requestId: scope.requestId } : {}),
    ...(data !== undefined ? { data: { ...data } } : {}),
  };
};

// Resolved lazily on first admission check and memoized for the process —
// never at module-evaluation time. `packages/api/src/app.ts` imports the
// whole `src/crowi` graph before calling `dotenv.config()` (probe F-8), so a
// module-level read here would silently ignore an operator's cwd `.env`.
let cachedFloor: LogLevel | undefined;

function resolveFloor(): LogLevel {
  if (cachedFloor !== undefined) return cachedFloor;
  const parsed = parseLogLevel(process.env.LOG_LEVEL);
  cachedFloor = parsed.level;
  if (parsed.invalidValue !== undefined) {
    // The floor has already resolved to 'info' on this branch, so a 'warn'
    // record is always admitted — this bypasses `isAdmitted` rather than
    // recursing back into it.
    const record = createLogRecord('warn', 'crowi:logger', 'invalid LOG_LEVEL; using info', {
      value: parsed.invalidValue,
      fallback: 'info',
    });
    productionSink.write(record);
  }
  return cachedFloor;
}

function isAdmitted(level: LogLevel, namespace: string): boolean {
  const floor = resolveFloor();
  if (SEVERITY[level] < SEVERITY[floor]) return false;
  // `DEBUG` only narrows which debug namespaces are admitted once the floor
  // itself already allows 'debug'; it never suppresses info/warn/error and
  // never admits debug below a higher floor (brief §6).
  if (level === 'debug' && !Debug.enabled(namespace)) return false;
  return true;
}

function emit(level: LogLevel, namespace: string, message: string, data?: LogData): void {
  try {
    if (!isAdmitted(level, namespace)) return;
    const record = createLogRecord(level, namespace, message, data);
    productionSink.write(record);
  } catch {
    // Logger methods never throw or reject caller code (brief §5.1): a
    // fatal-boundary caller depends on that guarantee to reach `writeFatal`
    // unconditionally, so a metadata-construction failure here is contained
    // rather than propagated.
  }
}

function emitError(namespace: string, message: string, error: unknown, data?: LogData): void {
  try {
    if (!isAdmitted('error', namespace)) return;
    // Built inside the same containment boundary: a throwing getter on
    // caller `data` must not escape this method either.
    const merged: LogData = { ...data, error };
    const record = createLogRecord('error', namespace, message, merged);
    productionSink.write(record);
  } catch {
    // See `emit` above.
  }
}

export const createLogger = (namespace: string): Logger => ({
  debug: (message, data) => emit('debug', namespace, message, data),
  info: (message, data) => emit('info', namespace, message, data),
  warn: (message, data) => emit('warn', namespace, message, data),
  error: (message, error, data) => emitError(namespace, message, error, data),
});
