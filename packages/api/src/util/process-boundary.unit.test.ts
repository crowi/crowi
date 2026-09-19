/**
 * RFC-0025 process-boundary — `unit` project coverage (no Crowi/Mongo/Hono
 * boot; see `jest.config.js`'s `unit` project doc comment). Two kinds of
 * cases live here:
 *
 *  - In-process cases that mock `./logger` / `./logger-sink` / `src/crowi`
 *    / `dotenv` and drive `./process-boundary` (or the real `../app` entry)
 *    through `jest.isolateModules`, so each case gets a FRESH module
 *    instance (fresh `fatalHandlersInstalled` flag, fresh module-level
 *    `shutdownLogger`) and never registers a real listener on the shared
 *    Jest worker process.
 *  - Genuinely separate OS child processes (`runFatalChild`), spawned via
 *    `tsx`, that exercise the REAL, functioning fatal sink end to end —
 *    real exit codes, real stderr bytes.
 */
import { spawn } from 'node:child_process';
import path from 'node:path';
import { createFailureReasonFault, type FailureReasonFaultMode, FatalWriteSentinel, installOneShotTimestampFaultSpy } from '../test/process-fatal-test-doubles';
import { TEST_SECRET_TOKEN } from '../test/secret-token-env';
import type { ShutdownCrowi } from './process-boundary';

// ---------------------------------------------------------------------------
// Shared child-process harness (AC-P04/P05/P06/P08/P09)
// ---------------------------------------------------------------------------

const API_PACKAGE_ROOT = path.resolve(__dirname, '..', '..');
const CHILD_FIXTURE_PATH = path.join(__dirname, 'process-boundary-child-fixture.ts');
const REAL_ENTRY_PATH = path.join(API_PACKAGE_ROOT, 'src', 'app.ts');
const HOOK_MARKER_PREFIX = '@@process-boundary-fixture:hook-invoked ';

function resolveTsxLoader(): string {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  return require.resolve('tsx');
}

interface FatalChildResult {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
}

/**
 * Spawns `scriptPath` as a genuinely separate OS process via `tsx`, always
 * from `packages/api` (so a real entry's own `src/...` bare-specifier
 * imports resolve through tsx's own tsconfig auto-discovery — the fixture
 * itself needs no alias resolution at all, see its doc comment). Owns its
 * own deadline: on timeout it SIGKILLs the child, closes its pipes, and
 * fails with a timeout error instead of depending on the Jest case timeout
 * (which would leave an orphaned child spinning a CPU core).
 */
function runFatalChild(scriptPath: string, options: { env?: Record<string, string>; nodeArgs?: string[]; timeoutMs: number }): Promise<FatalChildResult> {
  return new Promise((resolve, reject) => {
    const childEnv: NodeJS.ProcessEnv = { ...process.env, ...options.env };
    delete childEnv.NODE_OPTIONS;
    delete childEnv.JEST_WORKER_ID;

    const child = spawn(process.execPath, [...(options.nodeArgs ?? []), '--import', resolveTsxLoader(), scriptPath], {
      cwd: API_PACKAGE_ROOT,
      env: childEnv,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    let settled = false;

    const deadline = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill('SIGKILL');
      child.stdout.destroy();
      child.stderr.destroy();
      reject(
        new Error(
          `runFatalChild: timed out after ${options.timeoutMs}ms waiting for ${scriptPath} to close ` +
            `(stdout so far: ${stdout.slice(0, 2000)}; stderr so far: ${stderr.slice(0, 2000)})`,
        ),
      );
    }, options.timeoutMs);

    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8');
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
    });
    child.once('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      reject(err);
    });
    child.once('close', (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      resolve({ code, signal, stdout, stderr });
    });
  });
}

function parseStructuredProcessRecords(output: string): Record<string, unknown>[] {
  return output
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => {
      try {
        return JSON.parse(line) as unknown;
      } catch {
        return null;
      }
    })
    .filter(
      (parsed): parsed is Record<string, unknown> =>
        parsed !== null && typeof parsed === 'object' && (parsed as Record<string, unknown>).namespace === 'crowi:process',
    );
}

// ---------------------------------------------------------------------------
// Shared in-process harness (AC-P07/P10-P24)
// ---------------------------------------------------------------------------

type ProcessOnCall = { event: string | symbol; listener: (...args: unknown[]) => void };

/** Records every `process.on` call's exact arguments instead of registering a real listener on the shared Jest worker process. */
function recordProcessListeners(sequence?: string[]): { calls: ProcessOnCall[]; restore: () => void } {
  const calls: ProcessOnCall[] = [];
  const spy = jest.spyOn(process, 'on').mockImplementation(((event: string | symbol, listener: (...args: unknown[]) => void) => {
    calls.push({ event, listener });
    sequence?.push(`process.on:${String(event)}`);
    return process;
  }) as typeof process.on);
  return {
    calls,
    restore: () => {
      spy.mockRestore();
    },
  };
}

interface LoggerDouble {
  debug: jest.Mock;
  info: jest.Mock;
  warn: jest.Mock;
  error: jest.Mock;
}

function createLoggerDouble(): LoggerDouble {
  return { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() };
}

/**
 * Mocks `./logger`'s `createLogger` with a factory that returns a fresh
 * call-recording double per invocation, while spreading
 * `jest.requireActual`'s exports so `createLogRecord` (the real Phase 1
 * record factory) stays intact — block-scoped callers rely on the REAL
 * factory for full-record construction, and only want `createLogger`
 * itself replaced.
 */
function mockLoggerModule(): { created: LoggerDouble[]; factory: jest.Mock } {
  const created: LoggerDouble[] = [];
  const factory = jest.fn((_namespace: string): LoggerDouble => {
    const double = createLoggerDouble();
    created.push(double);
    return double;
  });
  jest.doMock('./logger', () => {
    const actual = jest.requireActual('./logger') as typeof import('./logger');
    return { ...actual, createLogger: factory };
  });
  return { created, factory };
}

function mockSinkModule(): jest.Mock {
  const writeFatalMock = jest.fn((record: unknown) => {
    throw new FatalWriteSentinel(record);
  });
  jest.doMock('./logger-sink', () => ({ writeFatal: writeFatalMock, write: jest.fn() }));
  return writeFatalMock;
}

/** Bounded poll for a mock the entry never lets a caller `await` directly (the entry's own `.catch(...)` chain isn't retained). */
function waitForMockCall(mock: jest.Mock, timeoutMs: number): Promise<void> {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    const check = (): void => {
      if (mock.mock.calls.length > 0) {
        resolve();
        return;
      }
      if (Date.now() - start > timeoutMs) {
        reject(new Error(`waitForMockCall: timed out after ${timeoutMs}ms waiting for a call`));
        return;
      }
      setTimeout(check, 5);
    };
    check();
  });
}

interface FatalListenerHarness {
  processOn: ReturnType<typeof recordProcessListeners>;
  writeFatalMock: jest.Mock;
  boundary: typeof import('./process-boundary');
  runWithRequestScope: typeof import('./request-scope').runWithRequestScope;
}

function isolateFatalListenerHarness(): FatalListenerHarness {
  const processOn = recordProcessListeners();
  let harness!: FatalListenerHarness;
  jest.isolateModules(() => {
    mockLoggerModule();
    const writeFatalMock = mockSinkModule();
    // eslint-disable-next-line @typescript-eslint/no-require-imports, @typescript-eslint/no-var-requires
    const boundary = require('./process-boundary') as typeof import('./process-boundary');
    // eslint-disable-next-line @typescript-eslint/no-require-imports, @typescript-eslint/no-var-requires
    const requestScope = require('./request-scope') as typeof import('./request-scope');
    boundary.installProcessFatalHandlers();
    harness = { processOn, writeFatalMock, boundary, runWithRequestScope: requestScope.runWithRequestScope };
  });
  return harness;
}

function restoreFatalListenerHarness(h: FatalListenerHarness): void {
  h.processOn.restore();
  jest.dontMock('./logger');
  jest.dontMock('./logger-sink');
}

function getListener(h: FatalListenerHarness, event: 'uncaughtException' | 'unhandledRejection'): (...args: unknown[]) => void {
  const call = h.processOn.calls.find((c) => c.event === event);
  if (!call) throw new Error(`no ${event} listener captured`);
  return call.listener;
}

interface ShutdownHarness {
  loggerDoubles: LoggerDouble[];
  loggerFactory: jest.Mock;
  boundary: typeof import('./process-boundary');
}

function isolateShutdownHarness(): ShutdownHarness {
  let harness!: ShutdownHarness;
  jest.isolateModules(() => {
    const { created, factory } = mockLoggerModule();
    // eslint-disable-next-line @typescript-eslint/no-require-imports, @typescript-eslint/no-var-requires
    const boundary = require('./process-boundary') as typeof import('./process-boundary');
    harness = { loggerDoubles: created, loggerFactory: factory, boundary };
  });
  return harness;
}

function restoreShutdownHarness(): void {
  jest.dontMock('./logger');
}

interface EntryCrowiDouble {
  collabAttachment: unknown;
  presenceAttachment: unknown;
  notificationsAttachment: unknown;
  init: jest.Mock;
  start: jest.Mock;
  exitOnError: jest.Mock;
}

type EntryInitBehavior = 'pending' | { kind: 'init-reject'; value: unknown } | { kind: 'start-reject'; value: unknown };

interface EntryHarness {
  crowi: EntryCrowiDouble;
  constructorMock: jest.Mock;
  dotenvConfigMock: jest.Mock;
  processOn: ReturnType<typeof recordProcessListeners>;
  sequence: string[];
  shutdownLoggerDoubles: LoggerDouble[];
}

/**
 * Drives the REAL `../app` entry with `dotenv`, `src/crowi`, and
 * `./logger`'s `createLogger` doubled — `./process-boundary` itself is
 * never mocked (AC-P10). No real database/plugin/WebSocket/port/process
 * listener ever starts: the constructor double returns synchronously, and
 * `init`/`start` are fully controlled.
 */
function isolateEntryHarness(initBehavior: EntryInitBehavior): EntryHarness {
  const sequence: string[] = [];
  const processOn = recordProcessListeners(sequence);
  let crowi!: EntryCrowiDouble;
  let constructorMock!: jest.Mock;
  let dotenvConfigMock!: jest.Mock;
  let shutdownLoggerDoubles!: LoggerDouble[];

  jest.isolateModules(() => {
    dotenvConfigMock = jest.fn(() => {
      sequence.push('dotenv.config');
      return {};
    });
    jest.doMock('dotenv', () => ({ __esModule: true, default: { config: dotenvConfigMock } }));

    shutdownLoggerDoubles = mockLoggerModule().created;

    crowi = {
      collabAttachment: null,
      presenceAttachment: null,
      notificationsAttachment: null,
      init: jest.fn(),
      start: jest.fn(),
      exitOnError: jest.fn(),
    };

    if (initBehavior === 'pending') {
      crowi.init.mockImplementation(() => {
        sequence.push('init');
        return new Promise<void>(() => {
          // never resolves — this row only cares about entry ordering / wiring.
        });
      });
    } else if (initBehavior.kind === 'init-reject') {
      crowi.init.mockImplementation(() => {
        sequence.push('init');
        return Promise.reject(initBehavior.value);
      });
    } else {
      crowi.init.mockImplementation(() => {
        sequence.push('init');
        return Promise.resolve();
      });
      crowi.start.mockImplementation(() => {
        sequence.push('start');
        return Promise.reject(initBehavior.value);
      });
    }

    constructorMock = jest.fn(() => {
      sequence.push('Crowi constructor');
      return crowi;
    });
    jest.doMock('src/crowi', () => ({ __esModule: true, default: constructorMock }));

    // eslint-disable-next-line @typescript-eslint/no-require-imports
    require('../app');
  });

  return { crowi, constructorMock, dotenvConfigMock, processOn, sequence, shutdownLoggerDoubles };
}

function restoreEntryHarness(h: EntryHarness): void {
  h.processOn.restore();
  jest.dontMock('dotenv');
  jest.dontMock('src/crowi');
  jest.dontMock('./logger');
}

// ---------------------------------------------------------------------------

describe('process boundary', () => {
  describe('AC-P04: actual uncaught-exception child rows (Error / plain string)', () => {
    it.each([
      ['Error', 'error'],
      ['plain string', 'string'],
    ])(
      'raises Error and plain-string rows from a timer and exits 1 with one full uncaught-exception line on a functioning sink (%s row)',
      async (_label, valueMode) => {
        const result = await runFatalChild(CHILD_FIXTURE_PATH, {
          env: { CROWI_PROCESS_BOUNDARY_FIXTURE_MODE: 'exception', CROWI_PROCESS_BOUNDARY_FIXTURE_VALUE: valueMode },
          timeoutMs: 30_000,
        });
        expect(result.code).toBe(1);
        expect(result.signal).toBeNull();
        const records = parseStructuredProcessRecords(result.stderr);
        expect(records).toHaveLength(1);
        expect(records[0]).toMatchObject({ level: 'error', namespace: 'crowi:process', message: 'uncaught exception' });
        // Jest's own per-test timeout MUST exceed `runFatalChild`'s internal
        // deadline so OUR deadline (which SIGKILLs the child and closes its
        // pipes) always fires first on a genuine hang — otherwise Jest cancels
        // the test first and the spawned child is orphaned, still running.
      },
      45_000,
    );
  });

  describe('AC-P05: actual unhandled-rejection child rows across all six Node modes', () => {
    const REJECTION_MODES: { label: string; flag?: string; expectMessage: 'unhandled rejection' | 'uncaught exception' }[] = [
      { label: 'default', expectMessage: 'unhandled rejection' },
      { label: 'throw', flag: '--unhandled-rejections=throw', expectMessage: 'unhandled rejection' },
      { label: 'strict', flag: '--unhandled-rejections=strict', expectMessage: 'uncaught exception' },
      { label: 'warn', flag: '--unhandled-rejections=warn', expectMessage: 'unhandled rejection' },
      { label: 'warn-with-error-code', flag: '--unhandled-rejections=warn-with-error-code', expectMessage: 'unhandled rejection' },
      { label: 'none', flag: '--unhandled-rejections=none', expectMessage: 'unhandled rejection' },
    ];

    it.each(
      REJECTION_MODES,
    )('clears NODE_OPTIONS and JEST_WORKER_ID and exits 1 with one mode-specific rejection line in every supported mode ($label mode expects $expectMessage)', async ({
      flag,
      expectMessage,
    }) => {
      const result = await runFatalChild(CHILD_FIXTURE_PATH, {
        nodeArgs: flag ? [flag] : [],
        env: { CROWI_PROCESS_BOUNDARY_FIXTURE_MODE: 'rejection', CROWI_PROCESS_BOUNDARY_FIXTURE_VALUE: 'error' },
        timeoutMs: 30_000,
      });
      expect(result.code).toBe(1);
      expect(result.signal).toBeNull();
      const records = parseStructuredProcessRecords(result.stderr);
      expect(records).toHaveLength(1);
      expect(records[0]).toMatchObject({ level: 'error', namespace: 'crowi:process', message: expectMessage });
    }, 45_000);
  });

  describe('AC-P06: real entry constructor-validation failure', () => {
    it('after clearing NODE_OPTIONS and JEST_WORKER_ID, from packages/api cwd fails invalid CROWI_ENCRYPTION_KEY before init and emits the fail marker plus exactly one structured line without reporter output or real boot', async () => {
      const result = await runFatalChild(REAL_ENTRY_PATH, {
        env: { SECRET_TOKEN: TEST_SECRET_TOKEN, CROWI_ENCRYPTION_KEY: 'not-a-valid-32-byte-base64-key', NODE_ENV: 'test' },
        timeoutMs: 45_000,
      });
      expect(result.code).toBe(1);
      expect(result.signal).toBeNull();

      const stdoutLines = result.stdout
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line.length > 0);
      const markerLines = stdoutLines.filter((line) => line.includes('@@crowi:fail'));
      expect(markerLines).toHaveLength(1);
      expect(markerLines[0]).toContain('@@crowi:fail api');
      expect(result.stdout).not.toMatch(/@@crowi:ready/);
      expect(result.stdout).not.toMatch(/\[boot]/);

      const records = parseStructuredProcessRecords(result.stderr);
      expect(records).toHaveLength(1);
      expect(records[0]).toMatchObject({ level: 'error', namespace: 'crowi:process', message: 'fatal API startup error' });
    }, 60_000);
  });

  describe('AC-P07: installer idempotency and no real Jest-worker listener registration', () => {
    it("inside one isolated registry, uses a pre-import recording process.on stub, installs each fatal listener once, and invokes the recorded callbacks with that registry's sink spy for real-factory full records without attaching worker listeners", () => {
      const h = isolateFatalListenerHarness();
      try {
        h.boundary.installProcessFatalHandlers();
        h.boundary.installProcessFatalHandlers();

        const exceptionCalls = h.processOn.calls.filter((c) => c.event === 'uncaughtException');
        const rejectionCalls = h.processOn.calls.filter((c) => c.event === 'unhandledRejection');
        expect(exceptionCalls).toHaveLength(1);
        expect(rejectionCalls).toHaveLength(1);

        const err = new Error('boom');
        expect(() => exceptionCalls[0].listener(err, 'uncaughtException')).toThrow(FatalWriteSentinel);
        expect(h.writeFatalMock).toHaveBeenCalledTimes(1);
        expect(h.writeFatalMock.mock.calls[0][0]).toMatchObject({
          level: 'error',
          namespace: 'crowi:process',
          message: 'uncaught exception',
          data: { error: err, origin: 'uncaughtException' },
        });

        h.writeFatalMock.mockClear();

        const reason = new Error('rejected');
        const rejectionPromise = Promise.resolve();
        expect(() => rejectionCalls[0].listener(reason, rejectionPromise)).toThrow(FatalWriteSentinel);
        expect(h.writeFatalMock).toHaveBeenCalledTimes(1);
        expect(h.writeFatalMock.mock.calls[0][0]).toMatchObject({
          level: 'error',
          namespace: 'crowi:process',
          message: 'unhandled rejection',
          data: { error: reason },
        });
      } finally {
        restoreFatalListenerHarness(h);
      }
    });
  });

  describe('AC-P08: actual exception child rows — F-R1/F-R2 combined with a timestamp-formatter fault', () => {
    // F-R3 (`Symbol.toPrimitive` never returning) is deliberately NOT a row
    // here, unlike AC-P09/AC-P18/AC-P20: a genuinely thrown non-Error,
    // non-primitive value reaches V8's per-isolate message handler BEFORE
    // Node dispatches to any `uncaughtException` listener, and that handler
    // itself calls `Object::ToString` on the thrown value (confirmed with a
    // standalone repro — a bare `getPrototypeOf`-trapped Proxy and an
    // accessor `message` are untouched by it, only a non-Error object's
    // `Symbol.toPrimitive` fires, with hint `'string'`, from a single native
    // frame). This happens whether or not a listener is installed, so
    // "zero hook executions" is unsatisfiable for this row — not a defect in
    // this leaf's code. AC-P20's F-R3 row (which invokes the SAME listener
    // function directly, bypassing V8's message handler entirely) is the
    // exception-listener coverage for F-R3; AC-P09's F-R3 row covers the
    // rejection listener, whose delivery path carries no V8 message and is
    // genuinely untouched. This also means: a thrown (not rejected) hostile
    // value whose `Symbol.toPrimitive` never returns hangs the process
    // before this leaf's own code ever runs — the same class of residual
    // risk the spec's "serialization が終了しない value" concession already
    // accepts, not a new gap this leaf introduces.
    const FAULT_ROWS: { label: string; valueMode: string }[] = [
      { label: 'F-R1: a Proxy whose getPrototypeOf would throw', valueMode: 'fault:proxy' },
      { label: 'F-R2: an Error whose message is an accessor', valueMode: 'fault:accessor' },
    ];

    it.each(
      FAULT_ROWS,
    )('with a self-killing child deadline, combines F-R1 F-R2 and F-R3 with a self-restoring timestamp fault and exits 1 with one fixed-epoch exception reduced line and zero hook executions ($label)', async ({
      valueMode,
    }) => {
      const result = await runFatalChild(CHILD_FIXTURE_PATH, {
        env: {
          CROWI_PROCESS_BOUNDARY_FIXTURE_MODE: 'exception',
          CROWI_PROCESS_BOUNDARY_FIXTURE_VALUE: valueMode,
          CROWI_PROCESS_BOUNDARY_FIXTURE_BREAK_TIMESTAMP: '1',
        },
        timeoutMs: 30_000,
      });
      expect(result.code).toBe(1);
      expect(result.signal).toBeNull();
      expect(result.stdout).not.toContain(HOOK_MARKER_PREFIX);
      const records = parseStructuredProcessRecords(result.stderr);
      expect(records).toHaveLength(1);
      expect(records[0]).toMatchObject({
        timestamp: '1970-01-01T00:00:00.000Z',
        level: 'error',
        namespace: 'crowi:process',
        message: 'uncaught exception',
        data: { reduced: true, reason: 'unknown process failure' },
      });
    }, 45_000);
  });

  describe('AC-P09: actual rejection child rows — F-R1/F-R2/F-R3 combined with a timestamp-formatter fault', () => {
    const FAULT_ROWS: { label: string; valueMode: string }[] = [
      { label: 'F-R1: a Proxy whose getPrototypeOf would throw', valueMode: 'fault:proxy' },
      { label: 'F-R2: an Error whose message is an accessor', valueMode: 'fault:accessor' },
      { label: 'F-R3: a value whose Symbol.toPrimitive would never return', valueMode: 'fault:symbol' },
    ];

    it.each(
      FAULT_ROWS,
    )('with a self-killing child deadline, combines F-R1 F-R2 and F-R3 with a self-restoring timestamp fault and exits 1 with one fixed-epoch rejection reduced line and zero hook executions ($label)', async ({
      valueMode,
    }) => {
      const result = await runFatalChild(CHILD_FIXTURE_PATH, {
        env: {
          CROWI_PROCESS_BOUNDARY_FIXTURE_MODE: 'rejection',
          CROWI_PROCESS_BOUNDARY_FIXTURE_VALUE: valueMode,
          CROWI_PROCESS_BOUNDARY_FIXTURE_BREAK_TIMESTAMP: '1',
        },
        timeoutMs: 30_000,
      });
      expect(result.code).toBe(1);
      expect(result.signal).toBeNull();
      expect(result.stdout).not.toContain(HOOK_MARKER_PREFIX);
      const records = parseStructuredProcessRecords(result.stderr);
      expect(records).toHaveLength(1);
      expect(records[0]).toMatchObject({
        timestamp: '1970-01-01T00:00:00.000Z',
        level: 'error',
        namespace: 'crowi:process',
        message: 'unhandled rejection',
        data: { reduced: true, reason: 'unknown process failure' },
      });
    }, 45_000);
  });

  describe('AC-P10: real entry ordering — environment load < fatal registration < construction < signal registration < init', () => {
    it("inside one isolated registry applies D-P7's sequence observation rule without mocking the boundary module", () => {
      const h = isolateEntryHarness('pending');
      try {
        const idx = (label: string): number => h.sequence.indexOf(label);
        expect(idx('dotenv.config')).toBeGreaterThanOrEqual(0);
        expect(idx('process.on:uncaughtException')).toBeGreaterThan(idx('dotenv.config'));
        expect(idx('process.on:unhandledRejection')).toBeGreaterThan(idx('dotenv.config'));
        expect(idx('Crowi constructor')).toBeGreaterThan(idx('process.on:uncaughtException'));
        expect(idx('Crowi constructor')).toBeGreaterThan(idx('process.on:unhandledRejection'));
        expect(idx('process.on:SIGINT')).toBeGreaterThan(idx('Crowi constructor'));
        expect(idx('process.on:SIGTERM')).toBeGreaterThan(idx('Crowi constructor'));
        expect(idx('init')).toBeGreaterThan(idx('process.on:SIGINT'));
        expect(idx('init')).toBeGreaterThan(idx('process.on:SIGTERM'));
        expect(h.crowi.start).not.toHaveBeenCalled();
      } finally {
        restoreEntryHarness(h);
      }
    });
  });

  describe('AC-P11: shutdown attempts every present attachment serially despite failures', () => {
    it('attempts every snapshotted present attachment serially despite failures before exit 0', async () => {
      const h = isolateShutdownHarness();
      try {
        const order: string[] = [];
        const collab = {
          shutdown: jest.fn(async () => {
            order.push('collab:attempted');
            throw new Error('collab failed');
          }),
        };
        const presence = {
          shutdown: jest.fn(async () => {
            order.push('presence:attempted');
          }),
        };
        const notifications = {
          shutdown: jest.fn(async () => {
            order.push('notifications:attempted');
            throw new Error('notifications failed');
          }),
        };
        const crowi = {
          collabAttachment: collab,
          presenceAttachment: presence,
          notificationsAttachment: notifications,
        } as unknown as ShutdownCrowi;
        const exit = jest.fn();

        await h.boundary.createShutdownHandler(crowi, exit)('SIGTERM');

        expect(order).toEqual(['collab:attempted', 'presence:attempted', 'notifications:attempted']);
        expect(exit).toHaveBeenCalledTimes(1);
        expect(exit).toHaveBeenCalledWith(0);
        const [shutdownLoggerDouble] = h.loggerDoubles;
        expect(shutdownLoggerDouble.error).toHaveBeenCalledTimes(2);
      } finally {
        restoreShutdownHarness();
      }
    });
  });

  describe('AC-P12: shutdown logger factory and receipt call', () => {
    it('inside one fresh isolated registry calls the factory once with crowi:shutdown and makes one info receipt call with signal data and no console.log call without clearing or claiming admission', async () => {
      const consoleLogSpy = jest.spyOn(console, 'log').mockImplementation(() => undefined);
      const h = isolateShutdownHarness();
      try {
        const crowi = { collabAttachment: null, presenceAttachment: null, notificationsAttachment: null } as unknown as ShutdownCrowi;
        const exit = jest.fn();
        await h.boundary.createShutdownHandler(crowi, exit)('SIGINT');

        expect(h.loggerFactory).toHaveBeenCalledTimes(1);
        expect(h.loggerFactory).toHaveBeenCalledWith('crowi:shutdown');
        const [shutdownLoggerDouble] = h.loggerDoubles;
        expect(shutdownLoggerDouble.info).toHaveBeenCalledTimes(1);
        expect(shutdownLoggerDouble.info).toHaveBeenCalledWith('shutdown signal received', { signal: 'SIGINT' });
        expect(consoleLogSpy).not.toHaveBeenCalled();
      } finally {
        restoreShutdownHarness();
        consoleLogSpy.mockRestore();
      }
    });
  });

  describe('AC-P13: unconditional yield before all-null exit, and silent null-skip in a mixed snapshot', () => {
    it('always yields after receipt so a later signal listener begins before all-null exit, then silently skips null fields in mixed snapshots (all-null snapshot timing)', async () => {
      const h = isolateShutdownHarness();
      try {
        const exit = jest.fn();
        const crowi = { collabAttachment: null, presenceAttachment: null, notificationsAttachment: null } as unknown as ShutdownCrowi;
        const invocation = h.boundary.createShutdownHandler(crowi, exit)('SIGTERM');

        // A later same-signal listener's own synchronous dispatch would run
        // here, before this handler's (trivial, all-null) loop resumes.
        expect(exit).not.toHaveBeenCalled();
        let laterListenerRan = false;
        queueMicrotask(() => {
          laterListenerRan = true;
        });

        await invocation;
        expect(exit).toHaveBeenCalledTimes(1);
        expect(exit).toHaveBeenCalledWith(0);
        expect(laterListenerRan).toBe(true);
      } finally {
        restoreShutdownHarness();
      }
    });

    it('silently skips null fields and attempts only the present one in a mixed snapshot', async () => {
      const h = isolateShutdownHarness();
      try {
        const presence = { shutdown: jest.fn(async () => undefined) };
        const crowi = { collabAttachment: null, presenceAttachment: presence, notificationsAttachment: null } as unknown as ShutdownCrowi;
        const exit = jest.fn();
        await h.boundary.createShutdownHandler(crowi, exit)('SIGINT');
        expect(presence.shutdown).toHaveBeenCalledTimes(1);
        expect(exit).toHaveBeenCalledWith(0);
      } finally {
        restoreShutdownHarness();
      }
    });
  });

  describe('AC-P14: raw attachment-rejection handoff, unchanged, by reference', () => {
    // Plain (non-hostile) rows compare via `toHaveBeenCalledWith` (jest's
    // deep-equality). Hostile rows (F-R1/F-R2/F-R3, and a Proxy-adjacent
    // primitive/symbol/bigint set) instead compare the captured argument by
    // REFERENCE (`toBe`) — `toHaveBeenCalledWith`'s deep-equality machinery
    // itself calls `instanceof Error` / reads own keys, which would trip a
    // hostile getter/trap from the ASSERTION rather than production code.
    const PLAIN_REJECTION_VALUES: { label: string; value: unknown }[] = [
      { label: 'Error instance', value: new Error('boom') },
      { label: 'plain object', value: { code: 'ECONNRESET' } },
      { label: 'string', value: 'boom' },
      { label: 'null', value: null },
      { label: 'undefined', value: undefined },
      { label: 'symbol', value: Symbol('boom') },
      { label: 'bigint', value: 10n },
      { label: 'Error with no own message', value: new Error() },
    ];

    it.each(
      PLAIN_REJECTION_VALUES,
    )('hands every attachment rejection to the logger unchanged before the next attempt, exits 0, and makes none of the three console.error calls ($label)', async ({
      value,
    }) => {
      const consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
      const h = isolateShutdownHarness();
      try {
        const collab = {
          shutdown: jest.fn(async () => {
            throw value;
          }),
        };
        const presence = { shutdown: jest.fn(async () => undefined) };
        const notifications = { shutdown: jest.fn(async () => undefined) };
        const crowi = {
          collabAttachment: collab,
          presenceAttachment: presence,
          notificationsAttachment: notifications,
        } as unknown as ShutdownCrowi;
        const exit = jest.fn();

        await h.boundary.createShutdownHandler(crowi, exit)('SIGTERM');

        const [shutdownLoggerDouble] = h.loggerDoubles;
        expect(shutdownLoggerDouble.error).toHaveBeenCalledTimes(1);
        const call = shutdownLoggerDouble.error.mock.calls[0] as [string, unknown, Record<string, unknown>];
        expect(call[0]).toBe('attachment shutdown failed');
        expect(call[1]).toBe(value);
        expect(call[2]).toEqual({ attachment: 'collabAttachment' });
        expect(presence.shutdown).toHaveBeenCalledTimes(1);
        expect(notifications.shutdown).toHaveBeenCalledTimes(1);
        expect(exit).toHaveBeenCalledWith(0);
        expect(consoleErrorSpy).not.toHaveBeenCalled();
      } finally {
        restoreShutdownHarness();
        consoleErrorSpy.mockRestore();
      }
    });

    const FAULT_ROWS: { label: string; mode: FailureReasonFaultMode }[] = [
      { label: 'F-R1: a Proxy whose getPrototypeOf would throw', mode: 'proxy-get-prototype-of' },
      { label: 'F-R2: an Error whose message is an accessor', mode: 'error-message-accessor' },
      { label: 'F-R3: a value whose Symbol.toPrimitive would never return', mode: 'symbol-to-primitive' },
    ];

    it.each(FAULT_ROWS)('hands a $label rejection to the logger unchanged, by reference, with zero hook executions', async ({ mode }) => {
      const h = isolateShutdownHarness();
      try {
        const fault = createFailureReasonFault(mode);
        const collab = {
          shutdown: jest.fn(async () => {
            throw fault.value;
          }),
        };
        const crowi = {
          collabAttachment: collab,
          presenceAttachment: null,
          notificationsAttachment: null,
        } as unknown as ShutdownCrowi;
        const exit = jest.fn();

        await h.boundary.createShutdownHandler(crowi, exit)('SIGTERM');

        expect(fault.hookCalls()).toBe(0);
        const [shutdownLoggerDouble] = h.loggerDoubles;
        expect(shutdownLoggerDouble.error).toHaveBeenCalledTimes(1);
        const call = shutdownLoggerDouble.error.mock.calls[0] as [string, unknown, Record<string, unknown>];
        expect(call[0]).toBe('attachment shutdown failed');
        expect(call[1]).toBe(fault.value);
        expect(call[2]).toEqual({ attachment: 'collabAttachment' });
        expect(exit).toHaveBeenCalledWith(0);
      } finally {
        restoreShutdownHarness();
      }
    });
  });

  describe('AC-P16: init()/start() rejection forwarded to exitOnError', () => {
    it('in two isolated registry blocks, polls each fully doubled container handler until the real entry catch forwards the init or start rejection (init() rejection row)', async () => {
      const rejection = new Error('init failed');
      const h = isolateEntryHarness({ kind: 'init-reject', value: rejection });
      try {
        await waitForMockCall(h.crowi.exitOnError, 5000);
        expect(h.crowi.exitOnError).toHaveBeenCalledTimes(1);
        expect(h.crowi.exitOnError).toHaveBeenCalledWith(rejection);
        expect(h.crowi.start).not.toHaveBeenCalled();
      } finally {
        restoreEntryHarness(h);
      }
    }, 10_000);

    it('forwards a start() rejection to exitOnError with the same value when init() resolves', async () => {
      const rejection = new Error('start failed');
      const h = isolateEntryHarness({ kind: 'start-reject', value: rejection });
      try {
        await waitForMockCall(h.crowi.exitOnError, 5000);
        expect(h.crowi.exitOnError).toHaveBeenCalledTimes(1);
        expect(h.crowi.exitOnError).toHaveBeenCalledWith(rejection);
        expect(h.crowi.start).toHaveBeenCalledTimes(1);
      } finally {
        restoreEntryHarness(h);
      }
    }, 10_000);
  });

  describe('AC-P17: live request scope keeps requestId and exact data on full exception/rejection records', () => {
    it('inside one isolated registry, uses its pre-import recording process.on arguments, sink spy, and live scope to keep requestId and exact data on full exception and rejection records (exception record)', () => {
      const h = isolateFatalListenerHarness();
      try {
        const listener = getListener(h, 'uncaughtException');
        const error = new Error('boom');
        expect(() =>
          h.runWithRequestScope({ requestId: 'req-exception' }, () => {
            listener(error, 'uncaughtException');
          }),
        ).toThrow(FatalWriteSentinel);
        expect(h.writeFatalMock).toHaveBeenCalledTimes(1);
        expect(h.writeFatalMock.mock.calls[0][0]).toMatchObject({
          requestId: 'req-exception',
          level: 'error',
          namespace: 'crowi:process',
          message: 'uncaught exception',
          data: { error, origin: 'uncaughtException' },
        });
      } finally {
        restoreFatalListenerHarness(h);
      }
    });

    it('keeps requestId and exact data (no Promise object) on a full rejection record', () => {
      const h = isolateFatalListenerHarness();
      try {
        const listener = getListener(h, 'unhandledRejection');
        const reason = new Error('rejected');
        expect(() =>
          h.runWithRequestScope({ requestId: 'req-rejection' }, () => {
            listener(reason);
          }),
        ).toThrow(FatalWriteSentinel);
        expect(h.writeFatalMock).toHaveBeenCalledTimes(1);
        const record = h.writeFatalMock.mock.calls[0][0] as Record<string, unknown>;
        expect(record.requestId).toBe('req-rejection');
        expect(record.data).toEqual({ error: reason });
      } finally {
        restoreFatalListenerHarness(h);
      }
    });
  });

  describe('AC-P20: live request scope — F-R1/F-R2/F-R3 combined with a timestamp fault reduce both listeners', () => {
    const FAULT_ROWS: { label: string; mode: FailureReasonFaultMode }[] = [
      { label: 'F-R1: a Proxy whose getPrototypeOf would throw', mode: 'proxy-get-prototype-of' },
      { label: 'F-R2: an Error whose message is an accessor', mode: 'error-message-accessor' },
      { label: 'F-R3: a value whose Symbol.toPrimitive would never return', mode: 'symbol-to-primitive' },
    ];

    it.each(
      FAULT_ROWS,
    )('inside one isolated registry combines every F-R row with timestamp failure and receives fixed-epoch reduced records from both listeners without requestId or hook execution; in-process F-R3 records entry then throws its sentinel ($label)', ({
      mode,
    }) => {
      const h = isolateFatalListenerHarness();
      try {
        const exceptionListener = getListener(h, 'uncaughtException');
        const exceptionFault = createFailureReasonFault(mode);
        installOneShotTimestampFaultSpy();
        expect(() =>
          h.runWithRequestScope({ requestId: 'req-x' }, () => {
            exceptionListener(exceptionFault.value, 'uncaughtException');
          }),
        ).toThrow(FatalWriteSentinel);
        expect(exceptionFault.hookCalls()).toBe(0);
        expect(h.writeFatalMock).toHaveBeenCalledTimes(1);
        const exceptionRecord = h.writeFatalMock.mock.calls[0][0] as Record<string, unknown>;
        expect(exceptionRecord).toMatchObject({
          timestamp: '1970-01-01T00:00:00.000Z',
          level: 'error',
          namespace: 'crowi:process',
          message: 'uncaught exception',
          data: { reduced: true, reason: 'unknown process failure' },
        });
        expect('requestId' in exceptionRecord).toBe(false);

        h.writeFatalMock.mockClear();

        const rejectionListener = getListener(h, 'unhandledRejection');
        const rejectionFault = createFailureReasonFault(mode);
        installOneShotTimestampFaultSpy();
        expect(() =>
          h.runWithRequestScope({ requestId: 'req-y' }, () => {
            rejectionListener(rejectionFault.value);
          }),
        ).toThrow(FatalWriteSentinel);
        expect(rejectionFault.hookCalls()).toBe(0);
        expect(h.writeFatalMock).toHaveBeenCalledTimes(1);
        const rejectionRecord = h.writeFatalMock.mock.calls[0][0] as Record<string, unknown>;
        expect(rejectionRecord).toMatchObject({
          timestamp: '1970-01-01T00:00:00.000Z',
          level: 'error',
          namespace: 'crowi:process',
          message: 'unhandled rejection',
          data: { reduced: true, reason: 'unknown process failure' },
        });
        expect('requestId' in rejectionRecord).toBe(false);
      } finally {
        restoreFatalListenerHarness(h);
      }
    });
  });

  describe('AC-P21: pauses on a manually resolved collab attachment and freezes the pre-await snapshot', () => {
    it('pauses on a manually resolved collab attachment and freezes the pre-await snapshot while rejecting a second invocation', async () => {
      const h = isolateShutdownHarness();
      try {
        let resolveCollab!: () => void;
        const collabPromise = new Promise<void>((resolve) => {
          resolveCollab = resolve;
        });
        const collab = { shutdown: jest.fn(() => collabPromise) };
        const crowiMutable: { collabAttachment: unknown; presenceAttachment: unknown; notificationsAttachment: unknown } = {
          collabAttachment: collab,
          presenceAttachment: null,
          notificationsAttachment: null,
        };
        const exit = jest.fn();
        const handler = h.boundary.createShutdownHandler(crowiMutable as unknown as ShutdownCrowi, exit);

        const firstInvocation = handler('SIGTERM');
        await Promise.resolve();
        await Promise.resolve();

        const lateAttachment = { shutdown: jest.fn(async () => undefined) };
        crowiMutable.presenceAttachment = lateAttachment;

        await handler('SIGINT');
        expect(lateAttachment.shutdown).not.toHaveBeenCalled();
        expect(exit).not.toHaveBeenCalled();
        const [shutdownLoggerDouble] = h.loggerDoubles;
        expect(shutdownLoggerDouble.info).toHaveBeenCalledTimes(1);

        resolveCollab();
        await firstInvocation;
        expect(exit).toHaveBeenCalledTimes(1);
        expect(lateAttachment.shutdown).not.toHaveBeenCalled();
      } finally {
        restoreShutdownHarness();
      }
    });
  });

  describe('AC-P22: separate-registry SIGINT/SIGTERM wrappers forward their own signal name', () => {
    it.each([
      'SIGINT',
      'SIGTERM',
    ] as const)('with per-registry process.on sink fully doubled container and process.exit stubs, invokes separate-registry wrappers to forward their own SIGINT and SIGTERM names (%s)', async (signal) => {
      const h = isolateEntryHarness('pending');
      const exitSpy = jest.spyOn(process, 'exit').mockImplementation(((): never => undefined as never) as never);
      try {
        const wrapperCall = h.processOn.calls.find((c) => c.event === signal);
        expect(wrapperCall).toBeDefined();
        (wrapperCall as ProcessOnCall).listener();
        await waitForMockCall(exitSpy as unknown as jest.Mock, 5000);
        const [shutdownLoggerDouble] = h.shutdownLoggerDoubles;
        expect(shutdownLoggerDouble.info).toHaveBeenCalledWith('shutdown signal received', { signal });
        expect(exitSpy).toHaveBeenCalledWith(0);
      } finally {
        exitSpy.mockRestore();
        restoreEntryHarness(h);
      }
    }, 10_000);
  });

  describe('AC-P23: same-registry SIGINT/SIGTERM wrappers share one genuinely paused one-shot handler', () => {
    it('with one manually resolved attachment and process.exit stubbed, proves same-registry wrappers share one genuinely paused one-shot handler', async () => {
      const h = isolateEntryHarness('pending');
      const exitSpy = jest.spyOn(process, 'exit').mockImplementation(((): never => undefined as never) as never);
      try {
        let resolveCollab!: () => void;
        const collabPromise = new Promise<void>((resolve) => {
          resolveCollab = resolve;
        });
        const collab = { shutdown: jest.fn(() => collabPromise) };
        h.crowi.collabAttachment = collab;

        const sigintWrapper = h.processOn.calls.find((c) => c.event === 'SIGINT')?.listener;
        const sigtermWrapper = h.processOn.calls.find((c) => c.event === 'SIGTERM')?.listener;
        expect(sigintWrapper).toBeDefined();
        expect(sigtermWrapper).toBeDefined();

        (sigintWrapper as () => void)();
        await Promise.resolve();
        await Promise.resolve();
        expect(collab.shutdown).toHaveBeenCalledTimes(1);

        (sigtermWrapper as () => void)();
        await Promise.resolve();
        await Promise.resolve();
        expect(collab.shutdown).toHaveBeenCalledTimes(1);
        expect(exitSpy).not.toHaveBeenCalled();
        const [shutdownLoggerDouble] = h.shutdownLoggerDoubles;
        expect(shutdownLoggerDouble.info).toHaveBeenCalledTimes(1);

        resolveCollab();
        await waitForMockCall(exitSpy as unknown as jest.Mock, 5000);
        expect(exitSpy).toHaveBeenCalledTimes(1);
        expect(exitSpy).toHaveBeenCalledWith(0);
      } finally {
        exitSpy.mockRestore();
        restoreEntryHarness(h);
      }
    }, 10_000);
  });

  describe('AC-P24: receipt precedes attachment work; each failure precedes the next attempt', () => {
    it('records receipt before attachment work and each failure before attempting the next attachment', async () => {
      const h = isolateShutdownHarness();
      try {
        const order: string[] = [];
        const [shutdownLoggerDouble] = h.loggerDoubles;
        shutdownLoggerDouble.info.mockImplementation((message: string) => {
          order.push(`info:${message}`);
        });
        shutdownLoggerDouble.error.mockImplementation((message: string) => {
          order.push(`error:${message}`);
        });

        const collab = {
          shutdown: jest.fn(async () => {
            order.push('collab:attempted');
            throw new Error('collab failed');
          }),
        };
        const presence = {
          shutdown: jest.fn(async () => {
            order.push('presence:attempted');
            throw new Error('presence failed');
          }),
        };
        const notifications = {
          shutdown: jest.fn(async () => {
            order.push('notifications:attempted');
          }),
        };
        const crowi = {
          collabAttachment: collab,
          presenceAttachment: presence,
          notificationsAttachment: notifications,
        } as unknown as ShutdownCrowi;
        const exit = jest.fn(() => {
          order.push('exit');
        });

        await h.boundary.createShutdownHandler(crowi, exit)('SIGTERM');

        expect(order).toEqual([
          'info:shutdown signal received',
          'collab:attempted',
          'error:attachment shutdown failed',
          'presence:attempted',
          'error:attachment shutdown failed',
          'notifications:attempted',
          'exit',
        ]);
      } finally {
        restoreShutdownHarness();
      }
    });
  });
});
