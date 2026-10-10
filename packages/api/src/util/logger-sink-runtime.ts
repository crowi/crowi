import type { LogData, LogLevel, LogRecord } from './logger';
import { serializeLogRecord } from './logger-serialize';

/** The only definitions of these numbers. */
const SINK_BUDGET = 1_048_576;
const SINK_WINDOW_MS = 60_000;
const FATAL_ATTEMPTS = 16;

export interface RecordSink {
  write(record: LogRecord): void;
  writeFatal(record: LogRecord): never;
  dispose(): void;
}

export interface RecordSinkDependencies {
  readonly stdout: NodeJS.WritableStream;
  readonly stderr: NodeJS.WritableStream;
  readonly stderrFd: number | undefined;
  readonly writeSync: typeof import('node:fs').writeSync;
  readonly exit: (code: number) => never;
  readonly now: () => number;
  readonly setTimeout: typeof globalThis.setTimeout;
  readonly clearTimeout: typeof globalThis.clearTimeout;
}

type ErrorKind = 'epipe' | 'callback' | 'event' | 'write-throw';
type StreamName = 'stdout' | 'stderr';

interface QueueEntry {
  readonly buffer: Buffer;
  readonly bytes: number;
  readonly countOnDrop: boolean;
}

interface StreamState {
  readonly name: StreamName;
  readonly stream: NodeJS.WritableStream;
  fifo: QueueEntry[];
  queuedBytes: number;
  blocked: boolean;
  broken: boolean;
  droppedRecords: number;
  droppedBytes: number;
  windowStartedAt: string | undefined;
  summaryTimer: ReturnType<typeof globalThis.setTimeout> | undefined;
  drainHandler: () => void;
}

function isLogLevel(value: unknown): value is LogLevel {
  return value === 'debug' || value === 'info' || value === 'warn' || value === 'error';
}

function safeReadField<T>(read: () => T): T | undefined {
  try {
    return read();
  } catch {
    return undefined;
  }
}

function saturatingAdd(current: number, delta: number): number {
  const next = current + delta;
  return next > Number.MAX_SAFE_INTEGER ? Number.MAX_SAFE_INTEGER : next;
}

function createStreamState(name: StreamName, stream: NodeJS.WritableStream): StreamState {
  return {
    name,
    stream,
    fifo: [],
    queuedBytes: 0,
    blocked: false,
    broken: false,
    droppedRecords: 0,
    droppedBytes: 0,
    windowStartedAt: undefined,
    summaryTimer: undefined,
    drainHandler: () => {},
  };
}

class RecordSinkImpl implements RecordSink {
  private readonly stdout: StreamState;

  private readonly stderr: StreamState;

  /**
   * Single runtime-wide fence. Every write callback, drain handler, error
   * handler, and summary timer captures this value when registered;
   * `dispose()` bumps it so a late arrival becomes a no-op without needing
   * every listener individually removed (the `error` listener specifically
   * cannot be removed — see `dispose()`).
   */
  private generation = 0;

  private disposed = false;

  constructor(private readonly deps: RecordSinkDependencies) {
    this.stdout = createStreamState('stdout', deps.stdout);
    this.stderr = createStreamState('stderr', deps.stderr);
    this.attachStreamListeners(this.stdout);
    this.attachStreamListeners(this.stderr);
  }

  private streamState(name: StreamName): StreamState {
    return name === 'stdout' ? this.stdout : this.stderr;
  }

  private attachStreamListeners(state: StreamState): void {
    const generation = this.generation;
    const drainHandler = (): void => {
      if (generation !== this.generation) return;
      // Clearing `blocked` FIRST is load-bearing: a stream can go blocked
      // with an empty FIFO (the very first oversized chunk returns `false`),
      // so draining the queue before clearing the flag would find nothing to
      // do and leave the direct-write gate closed for the rest of the
      // process.
      state.blocked = false;
      this.flush(state);
    };
    state.drainHandler = drainHandler;
    state.stream.on('drain', drainHandler);

    // Attached once for the stream's lifetime and never removed: a write
    // issued before `dispose()` can still fail afterwards, and a Node
    // `EventEmitter` with no `error` listener throws rather than dropping
    // the event. The generation fence (captured here, at construction) is
    // what silences a late arrival instead.
    state.stream.on('error', (err: NodeJS.ErrnoException) => {
      if (generation !== this.generation) return;
      const kind: ErrorKind = err?.code === 'EPIPE' ? 'epipe' : 'event';
      this.markBroken(state.name, kind);
    });
  }

  write(record: LogRecord): void {
    if (this.disposed) return;

    // The level is read exactly once and travels as data — reading it a
    // second time would let a hostile getter answer differently for
    // routing than for the envelope.
    const rawLevel = safeReadField(() => record.level);
    const level: LogLevel = isLogLevel(rawLevel) ? rawLevel : 'error';
    const namespace = safeReadField(() => record.namespace);
    const timestamp = safeReadField(() => record.timestamp);
    const message = safeReadField(() => record.message);
    const requestId = safeReadField(() => record.requestId);
    const data = safeReadField(() => record.data);

    const snapshot: Record<string, unknown> = { level, namespace, timestamp, message };
    if (requestId !== undefined) snapshot.requestId = requestId;
    if (data !== undefined) snapshot.data = data;

    const buffer = serializeLogRecord(snapshot as unknown as LogRecord);
    const streamName: StreamName = level === 'debug' || level === 'info' ? 'stdout' : 'stderr';
    this.routeWrite(streamName, buffer, true);
  }

  writeFatal(record: LogRecord): never {
    const buffer = serializeLogRecord(record);
    const primaryFd = typeof this.deps.stderrFd === 'number' && this.deps.stderrFd >= 0 ? this.deps.stderrFd : 2;

    let offset = 0;
    let ok = true;
    for (let attempt = 0; attempt < FATAL_ATTEMPTS && offset < buffer.length; attempt += 1) {
      let written: number;
      try {
        written = this.deps.writeSync(primaryFd, buffer, offset, buffer.length - offset);
      } catch {
        ok = false;
        break;
      }
      if (!Number.isFinite(written) || written <= 0 || written > buffer.length - offset) {
        ok = false;
        break;
      }
      offset += written;
    }
    if (offset < buffer.length) ok = false;

    if (!ok && offset < buffer.length) {
      // This fallback attempt targets descriptor 2 literally, independent of
      // `primaryFd`: it is the last resort after the primary descriptor
      // (which may not even BE 2) has already failed.
      try {
        this.deps.writeSync(2, buffer, offset, buffer.length - offset);
      } catch {
        // Best-effort; the outcome is ignored either way.
      }
    }

    this.deps.exit(1);
  }

  dispose(): void {
    this.disposed = true;
    this.generation += 1;
    for (const state of [this.stdout, this.stderr]) {
      this.clearSummaryTimer(state);
      state.fifo = [];
      state.queuedBytes = 0;
      state.stream.removeListener('drain', state.drainHandler);
      // `error` listener stays attached — see `attachStreamListeners`.
    }
  }

  /** Attempts to route `buffer` to `name`. Returns whether it was accepted (direct write or FIFO) or dropped. */
  private routeWrite(name: StreamName, buffer: Buffer, countOnDrop: boolean): 'accepted' | 'dropped' {
    const state = this.streamState(name);
    if (state.broken) {
      if (countOnDrop) this.recordDrop(state, buffer.length);
      return 'dropped';
    }

    const generation = this.generation;
    if (!state.blocked && state.fifo.length === 0) {
      try {
        const ok = state.stream.write(buffer, (err) => this.onWriteCallback(state, generation, buffer.length, err, countOnDrop));
        if (!ok) state.blocked = true;
        return 'accepted';
      } catch {
        if (countOnDrop) this.recordDrop(state, buffer.length);
        this.markBroken(name, 'write-throw');
        return 'dropped';
      }
    }

    if (state.queuedBytes + buffer.length > SINK_BUDGET) {
      if (countOnDrop) this.recordDrop(state, buffer.length);
      return 'dropped';
    }
    state.fifo.push({ buffer, bytes: buffer.length, countOnDrop });
    state.queuedBytes += buffer.length;
    return 'accepted';
  }

  private onWriteCallback(state: StreamState, generation: number, bytes: number, err: Error | null | undefined, countOnDrop: boolean): void {
    if (generation !== this.generation) return;
    if (err) {
      if (countOnDrop) this.recordDrop(state, bytes);
      this.markBroken(state.name, 'callback');
    }
  }

  private flush(state: StreamState): void {
    while (!state.blocked && !state.broken && state.fifo.length > 0) {
      const entry = state.fifo.shift();
      if (entry === undefined) break;
      state.queuedBytes -= entry.bytes;
      const generation = this.generation;
      try {
        const ok = state.stream.write(entry.buffer, (err) => this.onWriteCallback(state, generation, entry.bytes, err, entry.countOnDrop));
        if (!ok) state.blocked = true;
      } catch {
        if (entry.countOnDrop) this.recordDrop(state, entry.bytes);
        this.markBroken(state.name, 'write-throw');
        return;
      }
    }
  }

  private recordDrop(state: StreamState, bytes: number): void {
    const wasIdle = state.droppedRecords === 0 && state.droppedBytes === 0;
    state.droppedRecords = saturatingAdd(state.droppedRecords, 1);
    state.droppedBytes = saturatingAdd(state.droppedBytes, bytes);
    if (wasIdle) state.windowStartedAt = new Date().toISOString();
    this.armSummaryTimer(state);
  }

  private armSummaryTimer(state: StreamState): void {
    // stderr is the only summary destination; once it is broken, no timer
    // on either stream can ever be delivered, so none is armed — a later
    // drop on either stream must not re-arm one.
    if (this.stderr.broken) return;
    if (state.summaryTimer !== undefined) return;
    const generation = this.generation;
    // The deadline is `nextSummaryAt = now() + SINK_WINDOW_MS` at every arm,
    // computed fresh each time rather than by advancing a stale deadline.
    // With a relative-delay timer API the delay this derives to is always
    // `SINK_WINDOW_MS` — the read cannot change WHEN the timer fires. It
    // stays here so the injected monotonic clock is the actual, observable
    // source of the schedule (the drop-summary cadence tests assert it is
    // read once per arm/rearm, not left as a dead dependency), and so this
    // call site is where a future switch to an interval-based or
    // accumulated-deadline design — which COULD reintroduce a catch-up burst
    // of summaries — would have to change this arithmetic.
    const attemptedAt = this.deps.now();
    const nextSummaryAt = attemptedAt + SINK_WINDOW_MS;
    const delayMs = nextSummaryAt - attemptedAt;
    const timer = this.deps.setTimeout(() => this.attemptSummary(state, generation), delayMs);
    timer.unref?.();
    state.summaryTimer = timer;
  }

  private clearSummaryTimer(state: StreamState): void {
    if (state.summaryTimer !== undefined) {
      this.deps.clearTimeout(state.summaryTimer);
      state.summaryTimer = undefined;
    }
  }

  private attemptSummary(state: StreamState, generation: number): void {
    if (generation !== this.generation) return;
    state.summaryTimer = undefined;
    if (state.droppedRecords === 0) return;

    const data: LogData = {
      stream: state.name,
      droppedRecords: state.droppedRecords,
      droppedBytes: state.droppedBytes,
      windowStartedAt: state.windowStartedAt,
    };
    const record: LogRecord = {
      timestamp: new Date().toISOString(),
      level: 'warn',
      namespace: 'crowi:logger',
      message: 'log records dropped',
      data,
    };
    const buffer = serializeLogRecord(record);
    const outcome = this.routeWrite('stderr', buffer, false);
    if (outcome === 'accepted') {
      state.droppedRecords = 0;
      state.droppedBytes = 0;
      state.windowStartedAt = undefined;
      return;
    }
    // Refused: counters and window survive; a fresh deadline is computed
    // from the current attempt rather than advancing the old one, and
    // `armSummaryTimer` itself refuses to arm once stderr is broken.
    this.armSummaryTimer(state);
  }

  private markBroken(name: StreamName, errorKind: ErrorKind): void {
    const state = this.streamState(name);
    if (state.broken) return; // idempotent — only the first transition has effects

    state.broken = true;
    for (const entry of state.fifo) {
      if (entry.countOnDrop) this.recordDrop(state, entry.bytes);
    }
    state.fifo = [];
    state.queuedBytes = 0;
    state.blocked = false;
    // A stream's OWN pending drop-summary timer is not cancelled here: the
    // summary it will eventually build always targets stderr, independent
    // of whether THIS stream is broken — only stderr breaking invalidates
    // every summary timer, handled below.

    if (name === 'stderr') {
      // stderr is the only summary destination: an armed timer on EITHER
      // stream can now only wake up, find no route, and re-arm forever.
      // Cancel both and leave them cancelled.
      for (const target of [this.stdout, this.stderr]) {
        this.clearSummaryTimer(target);
      }
      return;
    }

    // stdout broke and stderr is (so far) healthy: offer exactly one
    // non-recursive diagnostic. If this write itself fails, it re-enters
    // `markBroken('stderr', ...)`, which is idempotent and — because it is
    // stderr breaking — offers no further diagnostic.
    if (!this.stderr.broken) {
      const record: LogRecord = {
        timestamp: new Date().toISOString(),
        level: 'error',
        namespace: 'crowi:logger',
        message: 'log stream disabled',
        data: { stream: 'stdout', errorKind },
      };
      const buffer = serializeLogRecord(record);
      this.routeWrite('stderr', buffer, false);
    }
  }
}

export const createRecordSink = (dependencies: RecordSinkDependencies): RecordSink => new RecordSinkImpl(dependencies);
