import type { LogData, LogLevel, LogRecord } from './logger';

// The ONLY definition of these numbers.
// Every limit below is measured in bytes after UTF-8 encoding.
const LIM = {
  message: 2048,
  stack: 32768,
  aggregate: 8,
  cause: 3,
  requestId: 128,
  string: 2048,
  name: 256,
  entries: 64,
  depth: 6,
  nodes: 512,
  data: 65536,
  record: 98304,
  fallback: 4096,
} as const;

const MARKER = {
  nonFinite: '[NonFinite]',
  undefined: '[Undefined]',
  symbol: '[Symbol]',
  function: '[Function]',
  accessor: '[Accessor]',
  circular: '[Circular]',
  depthExceeded: '[DepthExceeded]',
  nodesExceeded: '[NodesExceeded]',
  entriesOmitted: '[EntriesOmitted]',
  unstringifiable: '[Unstringifiable]',
} as const;

const VALID_LEVELS: readonly LogLevel[] = ['debug', 'info', 'warn', 'error'];
const ISO_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

// Fixed, precomputed, cannot fail — the last-resort output when even
// fallback-record construction fails. The epoch timestamp is deliberate:
// formatting "now" is itself code that can fail, and a terminal fallback
// must not depend on it.
const TERMINAL_FALLBACK_TEXT =
  '{"timestamp":"1970-01-01T00:00:00.000Z","level":"error","namespace":"crowi:logger","message":"log record serialization failed","data":{"fallback":true,"terminal":true}}\n';

const sharedEncoder = new TextEncoder();
// Fixed-size literal, not caller input — encoding it once at module load is
// not the unbounded-input case `encodeBoundedString` guards against.
const TRUNCATION_MARKER_BYTES = sharedEncoder.encode('…[truncated]');

/**
 * Converts `value` to at most `limit` UTF-8 bytes without ever measuring or
 * copying the whole (potentially caller-controlled, unbounded) input.
 * `TextEncoder.prototype.encodeInto` writes into a fixed-capacity
 * destination and never splits a multi-byte sequence, so the allocation is
 * bounded by `limit` rather than by the input. Every
 * `LIM.message`/`LIM.stack`/`LIM.string`/`LIM.name`/`LIM.requestId` path
 * goes through this one helper.
 */
function encodeBoundedString(value: string, limit: number): Buffer {
  const probe = new Uint8Array(limit);
  const probeResult = sharedEncoder.encodeInto(value, probe);
  if (probeResult.read === value.length) {
    return Buffer.from(probe.subarray(0, probeResult.written));
  }
  const contentLimit = Math.max(0, limit - TRUNCATION_MARKER_BYTES.length);
  const content = new Uint8Array(contentLimit);
  const contentResult = sharedEncoder.encodeInto(value, content);
  const bounded = new Uint8Array(contentResult.written + TRUNCATION_MARKER_BYTES.length);
  bounded.set(content.subarray(0, contentResult.written), 0);
  bounded.set(TRUNCATION_MARKER_BYTES, contentResult.written);
  return Buffer.from(bounded);
}

/** Thrown internally when a bounded writer's running total exceeds its budget; always caught, never observed by a caller. */
class BudgetExceededError extends Error {}

/**
 * Accumulates JSON bytes and aborts (throws `BudgetExceededError`) the
 * moment its running total exceeds `limit`. JSON-escaping an already-bounded
 * string can inflate up to ~6x (each byte becoming `\u00XX`), so even
 * individually-bounded fields can overflow `LIM.data`/`LIM.record` when
 * combined — this is checked incrementally rather than after building an
 * intermediate value, so a pathological record is never fully materialized.
 */
class BoundedWriter {
  private readonly chunks: Buffer[] = [];

  private bytes = 0;

  constructor(private readonly limit: number) {}

  get length(): number {
    return this.bytes;
  }

  /** A small, fixed, non-caller-controlled ASCII syntax token (braces, commas, ...). */
  syntax(token: string): void {
    this.append(Buffer.from(token, 'ascii'));
  }

  /** Writes an already-bounded buffer verbatim (no further encoding). */
  raw(buf: Buffer): void {
    this.append(buf);
  }

  /**
   * JSON-encodes an already-bounded UTF-8 buffer as a quoted string,
   * including the surrounding quotes. The round-trip through
   * `JSON.stringify` is bounded work because `bounded` is already ≤ its
   * row's limit — the unbounded step already happened in
   * `encodeBoundedString`.
   */
  jsonString(bounded: Buffer): void {
    const escaped = JSON.stringify(bounded.toString('utf-8'));
    this.append(Buffer.from(escaped, 'utf-8'));
  }

  private append(buf: Buffer): void {
    this.chunks.push(buf);
    this.bytes += buf.length;
    if (this.bytes > this.limit) throw new BudgetExceededError();
  }

  toBuffer(): Buffer {
    return Buffer.concat(this.chunks, this.bytes);
  }
}

interface TraversalState {
  nodeCount: number;
  readonly visited: Set<object>;
}

function boundedKeyText(key: string): { bytes: Buffer; text: string } {
  const bytes = encodeBoundedString(key, LIM.string);
  return { bytes, text: bytes.toString('utf-8') };
}

function isPlainContainer(value: unknown): value is Record<string, unknown> | unknown[] {
  return typeof value === 'object' && value !== null;
}

/** A bounded `String(value)`: `[Unstringifiable]` if the conversion itself throws. */
function boundedSafeDescription(value: unknown): Buffer {
  try {
    return encodeBoundedString(String(value), LIM.message);
  } catch {
    return encodeBoundedString(MARKER.unstringifiable, LIM.message);
  }
}

/**
 * Error normalization. `stack` is an own ACCESSOR on every Error instance,
 * so the generic own-data-descriptor rule would silently omit it forever —
 * this path reads `name`/`message`/`stack` by ORDINARY property access
 * instead, each independently guarded so a hostile subclass's throwing
 * getter drops only that one field.
 */
function writeErrorShape(writer: BoundedWriter, error: Error, includeStack: boolean, causeDepthRemaining: number): void {
  writer.syntax('{');
  let wroteAny = false;
  const emitField = (key: string, writeValue: () => void): void => {
    if (wroteAny) writer.syntax(',');
    writer.syntax(`"${key}":`);
    writeValue();
    wroteAny = true;
  };

  // Each field is read independently so a hostile subclass's throwing
  // getter on one field drops only that field rather than the whole shape
  // — a non-string read (thrown or wrong type) is treated as absent, never
  // coerced to a placeholder.
  const name = safeRead(() => error.name);
  if (typeof name === 'string') emitField('name', () => writer.jsonString(encodeBoundedString(name, LIM.name)));

  const message = safeRead(() => error.message);
  if (typeof message === 'string') emitField('message', () => writer.jsonString(encodeBoundedString(message, LIM.message)));

  // Only the OUTERMOST error carries `stack` — never a cause, never an
  // aggregate member.
  if (includeStack) {
    const stack = safeRead(() => error.stack);
    if (typeof stack === 'string') emitField('stack', () => writer.jsonString(encodeBoundedString(stack, LIM.stack)));
  }

  // `causeDepthRemaining < 0` marks a true leaf (an aggregate member): no
  // further `cause` chaining and no own `errors` list, even if the member
  // happens to be an AggregateError itself — a member is shallow: name and
  // bounded message only.
  if (causeDepthRemaining > 0) {
    const cause = safeRead(() => (error as { cause?: unknown }).cause);
    if (cause !== undefined) emitField('cause', () => writeCauseShape(writer, cause, causeDepthRemaining - 1));
  }

  if (causeDepthRemaining >= 0) {
    const aggregateErrors = safeRead(() => (error as { errors?: unknown }).errors);
    if (Array.isArray(aggregateErrors)) {
      emitField('errors', () => {
        writer.syntax('[');
        const items = aggregateErrors.slice(0, LIM.aggregate);
        items.forEach((member, index) => {
          if (index > 0) writer.syntax(',');
          writeShallowMember(writer, member);
        });
        writer.syntax(']');
      });
    }
  }

  writer.syntax('}');
}

/** The `{"name":<name>,"message":<bounded description>}` shape shared by every non-Error slot (shallow member, cause, or top-level error). */
function writeNonErrorShape(writer: BoundedWriter, name: 'NonErrorCause' | 'NonErrorThrow', value: unknown): void {
  writer.syntax('{"name":');
  writer.jsonString(encodeBoundedString(name, LIM.name));
  writer.syntax(',"message":');
  writer.jsonString(boundedSafeDescription(value));
  writer.syntax('}');
}

function writeShallowMember(writer: BoundedWriter, member: unknown): void {
  if (member instanceof Error) {
    writeErrorShape(writer, member, false, -1);
    return;
  }
  writeNonErrorShape(writer, 'NonErrorCause', member);
}

function writeCauseShape(writer: BoundedWriter, cause: unknown, causeDepthRemaining: number): void {
  if (Array.isArray(cause)) {
    writer.syntax('{"name":');
    writer.jsonString(encodeBoundedString('AggregateCause', LIM.name));
    writer.syntax(',"errors":[');
    const items = cause.slice(0, LIM.aggregate);
    items.forEach((member, index) => {
      if (index > 0) writer.syntax(',');
      writeShallowMember(writer, member);
    });
    writer.syntax(']}');
    return;
  }
  if (cause instanceof Error) {
    writeErrorShape(writer, cause, false, causeDepthRemaining);
    return;
  }
  writeNonErrorShape(writer, 'NonErrorCause', cause);
}

function safeRead<T>(fn: () => T): T | undefined {
  try {
    return fn();
  } catch {
    return undefined;
  }
}

/** The error slot at `data.error`: an Error normalizes fully; anything else becomes `NonErrorThrow`. */
function writeErrorSlot(writer: BoundedWriter, value: unknown): void {
  if (value instanceof Error) {
    writeErrorShape(writer, value, true, LIM.cause);
    return;
  }
  writeNonErrorShape(writer, 'NonErrorThrow', value);
}

/**
 * Traverses one arbitrary value within the `LIM` bounds.
 * `isTopLevelErrorSlot` selects the `data.error` exemption: ANY value there
 * becomes error-shaped, never the generic table.
 */
function writeValue(writer: BoundedWriter, value: unknown, depth: number, state: TraversalState, isTopLevelErrorSlot: boolean): void {
  if (isTopLevelErrorSlot) {
    writeErrorSlot(writer, value);
    return;
  }

  if (value instanceof Error) {
    writeErrorShape(writer, value, true, LIM.cause);
    return;
  }

  if (typeof value === 'string') {
    writer.jsonString(encodeBoundedString(value, LIM.string));
    return;
  }
  if (typeof value === 'number') {
    if (Number.isFinite(value)) {
      writer.syntax(JSON.stringify(value));
    } else {
      writer.jsonString(encodeBoundedString(MARKER.nonFinite, LIM.string));
    }
    return;
  }
  if (typeof value === 'bigint') {
    writer.jsonString(encodeBoundedString(value.toString(10), LIM.string));
    return;
  }
  if (typeof value === 'boolean') {
    writer.syntax(value ? 'true' : 'false');
    return;
  }
  if (value === null) {
    writer.syntax('null');
    return;
  }
  if (value === undefined) {
    writer.jsonString(encodeBoundedString(MARKER.undefined, LIM.string));
    return;
  }
  if (typeof value === 'symbol') {
    writer.jsonString(encodeBoundedString(MARKER.symbol, LIM.string));
    return;
  }
  if (typeof value === 'function') {
    writer.jsonString(encodeBoundedString(MARKER.function, LIM.string));
    return;
  }

  if (!isPlainContainer(value)) {
    // Unreachable for the JS type set above, but keeps the function total.
    writer.jsonString(encodeBoundedString(MARKER.unstringifiable, LIM.string));
    return;
  }

  if (depth > LIM.depth) {
    writer.jsonString(encodeBoundedString(MARKER.depthExceeded, LIM.string));
    return;
  }

  if (state.visited.has(value)) {
    writer.jsonString(encodeBoundedString(MARKER.circular, LIM.string));
    return;
  }

  state.nodeCount += 1;
  if (state.nodeCount > LIM.nodes) {
    writer.jsonString(encodeBoundedString(MARKER.nodesExceeded, LIM.string));
    return;
  }
  state.visited.add(value);

  if (Array.isArray(value)) {
    writeArray(writer, value, depth, state);
    return;
  }
  writeObject(writer, value as Record<string, unknown>, depth, state, false);
}

function writeArray(writer: BoundedWriter, arr: unknown[], depth: number, state: TraversalState): void {
  writer.syntax('[');
  const considered = arr.slice(0, LIM.entries);
  considered.forEach((item, index) => {
    if (index > 0) writer.syntax(',');
    writeValue(writer, item, depth + 1, state, false);
  });
  if (arr.length > LIM.entries) {
    if (considered.length > 0) writer.syntax(',');
    writer.jsonString(encodeBoundedString(MARKER.entriesOmitted, LIM.string));
  }
  writer.syntax(']');
}

function writeObject(writer: BoundedWriter, obj: Record<string, unknown>, depth: number, state: TraversalState, isTopLevelData: boolean): void {
  writer.syntax('{');

  const allKeys = Object.keys(obj);
  const errorKey = isTopLevelData && allKeys.includes('error') ? 'error' : undefined;
  const ordinaryKeys = errorKey !== undefined ? allKeys.filter((k) => k !== 'error') : allKeys;

  const considered = ordinaryKeys.slice(0, LIM.entries);
  const beyondCount = Math.max(0, ordinaryKeys.length - LIM.entries);

  const seenBoundedKeys = new Set<string>();
  let omittedCount = beyondCount;
  let wroteEntry = false;

  for (const key of considered) {
    const { bytes: keyBytes, text: keyText } = boundedKeyText(key);
    if (seenBoundedKeys.has(keyText)) {
      omittedCount += 1;
      continue;
    }
    seenBoundedKeys.add(keyText);

    const descriptor = Object.getOwnPropertyDescriptor(obj, key);
    if (wroteEntry) writer.syntax(',');
    writer.jsonString(keyBytes);
    writer.syntax(':');
    if (descriptor !== undefined && (descriptor.get !== undefined || descriptor.set !== undefined)) {
      writer.jsonString(encodeBoundedString(MARKER.accessor, LIM.string));
    } else {
      const entryValue = safeRead(() => obj[key]);
      writeValue(writer, entryValue, depth + 1, state, false);
    }
    wroteEntry = true;
  }

  if (omittedCount > 0) {
    if (wroteEntry) writer.syntax(',');
    writer.jsonString(encodeBoundedString(MARKER.entriesOmitted, LIM.string));
    writer.syntax(':');
    writer.syntax(JSON.stringify(omittedCount));
    wroteEntry = true;
  }

  if (errorKey !== undefined) {
    if (wroteEntry) writer.syntax(',');
    writer.jsonString(encodeBoundedString('error', LIM.string));
    writer.syntax(':');
    const errorValue = safeRead(() => obj.error);
    writeValue(writer, errorValue, depth + 1, state, true);
    wroteEntry = true;
  }

  writer.syntax('}');
}

function writeData(writer: BoundedWriter, data: LogData): void {
  // The `data` object itself is one container.
  const state: TraversalState = { nodeCount: 1, visited: new Set<object>([data]) };
  writeObject(writer, data as Record<string, unknown>, 0, state, true);
}

function normalizeLevel(level: unknown): LogLevel {
  return typeof level === 'string' && (VALID_LEVELS as readonly string[]).includes(level) ? (level as LogLevel) : 'error';
}

function normalizeNamespace(namespace: unknown): Buffer {
  return encodeBoundedString(typeof namespace === 'string' ? namespace : 'unknown', LIM.name);
}

function normalizeTimestamp(timestamp: unknown): string {
  return typeof timestamp === 'string' && ISO_TIMESTAMP.test(timestamp) ? timestamp : new Date().toISOString();
}

function normalizeMessage(message: unknown): Buffer {
  return encodeBoundedString(typeof message === 'string' ? message : '(invalid message)', LIM.message);
}

/**
 * A serialization/traversal failure keeps the ORIGINAL level, bounded
 * namespace, and the request id carried by the record being serialized.
 * This never reads the ALS request scope — a direct or late call would
 * otherwise correlate the fallback to whatever request chain the CALLER
 * happens to be on, not the record that actually failed.
 */
function buildFallback(record: LogRecord): Buffer {
  const writer = new BoundedWriter(LIM.fallback);
  writer.syntax('{"timestamp":"');
  writer.raw(Buffer.from(new Date().toISOString(), 'ascii'));
  writer.syntax('","level":');
  writer.jsonString(encodeBoundedString(normalizeLevel(safeRead(() => record.level)), LIM.name));
  writer.syntax(',"namespace":');
  writer.jsonString(normalizeNamespace(safeRead(() => record.namespace)));
  writer.syntax(',"message":"log record serialization failed"');
  const requestId = safeRead(() => record.requestId);
  if (typeof requestId === 'string') {
    writer.syntax(',"requestId":');
    writer.jsonString(encodeBoundedString(requestId, LIM.requestId));
  }
  writer.syntax(',"data":{"fallback":true}}');
  writer.syntax('\n');
  return writer.toBuffer();
}

/**
 * Always returns one bounded valid JSON object followed by exactly one LF.
 * Never throws. Every call returns a freshly allocated Buffer, including
 * the terminal fallback, so a caller mutating the result cannot corrupt a
 * later call.
 */
export const serializeLogRecord = (record: LogRecord): Buffer => {
  try {
    const level = normalizeLevel(safeRead(() => record.level));
    const namespace = normalizeNamespace(safeRead(() => record.namespace));
    const timestamp = normalizeTimestamp(safeRead(() => record.timestamp));
    const message = normalizeMessage(safeRead(() => record.message));
    const requestId = safeRead(() => record.requestId);
    const data = safeRead(() => record.data);

    let dataBuffer: Buffer | undefined;
    if (typeof data === 'object' && data !== null) {
      const dataWriter = new BoundedWriter(LIM.data);
      writeData(dataWriter, data);
      dataBuffer = dataWriter.toBuffer();
    }

    const recordWriter = new BoundedWriter(LIM.record);
    recordWriter.syntax('{"timestamp":');
    recordWriter.jsonString(Buffer.from(timestamp, 'utf-8'));
    recordWriter.syntax(',"level":');
    recordWriter.jsonString(Buffer.from(level, 'utf-8'));
    recordWriter.syntax(',"namespace":');
    recordWriter.jsonString(namespace);
    recordWriter.syntax(',"message":');
    recordWriter.jsonString(message);
    if (typeof requestId === 'string') {
      recordWriter.syntax(',"requestId":');
      recordWriter.jsonString(encodeBoundedString(requestId, LIM.requestId));
    }
    if (dataBuffer !== undefined) {
      recordWriter.syntax(',"data":');
      recordWriter.raw(dataBuffer);
    }
    recordWriter.syntax('}\n');
    return recordWriter.toBuffer();
  } catch {
    try {
      return buildFallback(record);
    } catch {
      return Buffer.from(TERMINAL_FALLBACK_TEXT, 'utf-8');
    }
  }
};
