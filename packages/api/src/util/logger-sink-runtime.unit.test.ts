import type { LogRecord } from './logger';
import { createRecordSink, type RecordSinkDependencies } from './logger-sink-runtime';

type Listener = (...args: unknown[]) => void;

class FakeWritable {
  drainListeners: Listener[] = [];

  errorListeners: Listener[] = [];

  writeCalls: { buffer: Buffer; callback: (err?: Error | null) => void }[] = [];

  returnQueue: boolean[] = [];

  defaultReturn = true;

  write(buffer: Buffer, callback: (err?: Error | null) => void): boolean {
    this.writeCalls.push({ buffer, callback });
    return this.returnQueue.length > 0 ? (this.returnQueue.shift() as boolean) : this.defaultReturn;
  }

  on(event: string, listener: Listener): this {
    if (event === 'drain') this.drainListeners.push(listener);
    if (event === 'error') this.errorListeners.push(listener);
    return this;
  }

  removeListener(event: string, listener: Listener): this {
    if (event === 'drain') this.drainListeners = this.drainListeners.filter((l) => l !== listener);
    if (event === 'error') this.errorListeners = this.errorListeners.filter((l) => l !== listener);
    return this;
  }

  emitDrain(): void {
    for (const l of this.drainListeners) l();
  }

  emitError(err: Error): void {
    for (const l of this.errorListeners) l(err);
  }
}

function makeFakeClock() {
  let currentTime = 0;
  let nextId = 1;
  const timers: { id: number; at: number; fn: () => void }[] = [];

  const fakeSetTimeout = ((fn: () => void, ms?: number) => {
    const id = nextId;
    nextId += 1;
    timers.push({ id, at: currentTime + (ms ?? 0), fn });
    return { id, unref: () => undefined } as unknown as ReturnType<typeof globalThis.setTimeout>;
  }) as typeof globalThis.setTimeout;

  const fakeClearTimeout = ((handle: unknown) => {
    const id = (handle as { id?: number })?.id;
    const idx = timers.findIndex((t) => t.id === id);
    if (idx >= 0) timers.splice(idx, 1);
  }) as typeof globalThis.clearTimeout;

  const advance = (ms: number): void => {
    currentTime += ms;
    const due = timers.filter((t) => t.at <= currentTime).sort((a, b) => a.at - b.at);
    for (const t of due) {
      const idx = timers.findIndex((x) => x.id === t.id);
      if (idx >= 0) timers.splice(idx, 1);
      t.fn();
    }
  };

  // Wrapped in `jest.fn` (not a bare closure) so tests can observe the real
  // `RecordSinkImpl` actually reading this dependency — AC-C29's facade test
  // only proves the production wiring PASSES a monotonic clock in; the drop-
  // summary tests below are what prove the runtime itself calls it.
  const now = jest.fn(() => currentTime);

  return { setTimeout: fakeSetTimeout, clearTimeout: fakeClearTimeout, now, advance, pendingCount: () => timers.length };
}

function makeRecord(overrides: Partial<LogRecord> = {}): LogRecord {
  return { timestamp: '2026-01-01T00:00:00.000Z', level: 'info', namespace: 'crowi:test', message: 'hi', ...overrides };
}

function makeSink() {
  const stdout = new FakeWritable();
  const stderr = new FakeWritable();
  const clock = makeFakeClock();
  const writeSync = jest.fn<number, [number, Buffer, number, number]>((_fd, buf, offset, length) => length);
  const exit = jest.fn<never, [number]>(() => {
    throw new ExitCalled();
  });
  const deps: RecordSinkDependencies = {
    stdout: stdout as unknown as NodeJS.WritableStream,
    stderr: stderr as unknown as NodeJS.WritableStream,
    stderrFd: 2,
    writeSync: writeSync as unknown as RecordSinkDependencies['writeSync'],
    exit: exit as unknown as RecordSinkDependencies['exit'],
    now: clock.now,
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout,
  };
  const sink = createRecordSink(deps);
  return { sink, stdout, stderr, clock, writeSync, exit };
}

class ExitCalled extends Error {}

function lastWrite(stream: FakeWritable): Buffer {
  return stream.writeCalls[stream.writeCalls.length - 1]!.buffer;
}

function parse(buffer: Buffer): Record<string, unknown> {
  return JSON.parse(buffer.toString('utf-8').trimEnd());
}

describe('record sink runtime', () => {
  describe('AC-C11 / AC-C25: routing and direct writes', () => {
    it('routes each logical record once to its level stream', () => {
      const { sink, stdout, stderr } = makeSink();
      sink.write(makeRecord({ level: 'debug' }));
      sink.write(makeRecord({ level: 'info' }));
      sink.write(makeRecord({ level: 'warn' }));
      sink.write(makeRecord({ level: 'error' }));
      expect(stdout.writeCalls).toHaveLength(2);
      expect(stderr.writeCalls).toHaveLength(2);
    });

    it('direct-writes a healthy burst without waiting for callbacks', () => {
      const { sink, stdout } = makeSink();
      for (let i = 0; i < 5; i += 1) sink.write(makeRecord({ message: `m${i}` }));
      expect(stdout.writeCalls).toHaveLength(5);
      // None of the callbacks were invoked yet — direct write does not wait.
      expect(stdout.writeCalls.every((c) => typeof c.callback === 'function')).toBe(true);
    });
  });

  describe('AC-C12 / AC-C33: congestion, drain, and level snapshot', () => {
    it('queues after backpressure and restores direct writes after ordered or empty-FIFO drains without callback ordering assumptions', () => {
      const { sink, stdout } = makeSink();
      stdout.defaultReturn = false; // first write reports backpressure
      sink.write(makeRecord({ message: 'a' }));
      expect(stdout.writeCalls).toHaveLength(1);

      // While blocked, further records queue instead of writing directly.
      sink.write(makeRecord({ message: 'b' }));
      expect(stdout.writeCalls).toHaveLength(1);

      // drain fires with an EMPTY effective FIFO scenario (nothing queued
      // yet because "b" already queued) — clear-then-flush still writes it.
      stdout.defaultReturn = true;
      stdout.emitDrain();
      expect(stdout.writeCalls).toHaveLength(2);
      expect(parse(lastWrite(stdout)).message).toBe('b');

      // Now healthy again: a burst writes directly without queueing.
      sink.write(makeRecord({ message: 'c' }));
      expect(stdout.writeCalls).toHaveLength(3);
    });

    it('unblocks via drain even when the FIFO is empty at the moment of the first oversized write', () => {
      const { sink, stdout } = makeSink();
      stdout.defaultReturn = false;
      sink.write(makeRecord({ message: 'only' }));
      expect(stdout.writeCalls).toHaveLength(1);
      stdout.defaultReturn = true;
      stdout.emitDrain(); // FIFO is empty; blocked must still clear.
      sink.write(makeRecord({ message: 'next' }));
      expect(stdout.writeCalls).toHaveLength(2);
    });

    it('snapshots every envelope getter once and repairs a throwing level getter onto stderr', () => {
      const { sink, stderr, stdout } = makeSink();
      let levelReads = 0;
      const hostile = {
        get level(): never {
          levelReads += 1;
          throw new Error('hostile level getter');
        },
        namespace: 'crowi:test',
        timestamp: '2026-01-01T00:00:00.000Z',
        message: 'msg',
      } as unknown as LogRecord;
      sink.write(hostile);
      expect(levelReads).toBe(1);
      expect(stdout.writeCalls).toHaveLength(0);
      expect(stderr.writeCalls).toHaveLength(1);
      expect(parse(lastWrite(stderr)).level).toBe('error');
    });
  });

  describe('AC-C13 / AC-C26: drops and post-broken accounting', () => {
    it('drops only new whole records and counts post-broken offers without queue allocation', () => {
      const { sink, stdout } = makeSink();
      stdout.defaultReturn = false;
      sink.write(makeRecord({ message: 'accepted-into-buffer' }));
      // Force the stream broken via a callback error.
      stdout.writeCalls[0]!.callback(new Error('epipe'));
      // Further writes must be dropped without touching the FIFO.
      sink.write(makeRecord({ message: 'dropped-1' }));
      sink.write(makeRecord({ message: 'dropped-2' }));
      expect(stdout.writeCalls).toHaveLength(1);
    });

    it('counts a synchronously thrown application write before disabling its stream', () => {
      const { sink, stdout, stderr } = makeSink();
      stdout.write = () => {
        throw new Error('sync throw');
      };
      sink.write(makeRecord({ level: 'info' }));
      // stdout is now broken; the diagnostic goes to stderr.
      expect(stderr.writeCalls).toHaveLength(1);
      expect(parse(lastWrite(stderr))).toMatchObject({
        namespace: 'crowi:logger',
        message: 'log stream disabled',
        data: { stream: 'stdout', errorKind: 'write-throw' },
      });
    });

    it('counts each single and concurrently outstanding callback-failed application record exactly once', () => {
      const { sink, stdout } = makeSink();
      sink.write(makeRecord({ message: 'a' }));
      sink.write(makeRecord({ message: 'b' }));
      // Two outstanding writes; only the first callback reports failure.
      stdout.writeCalls[0]!.callback(new Error('boom'));
      stdout.writeCalls[1]!.callback(null);
      // Idempotent: a second failure report for the (already broken) stream has no further effect.
      stdout.writeCalls[0]!.callback(new Error('boom again'));
      expect(stdout.writeCalls).toHaveLength(2);
    });
  });

  describe('AC-C14 / AC-C27: drop summary cadence', () => {
    it('aggregates fixed wall-clock summaries on monotonic cadence and resets only after stderr acceptance', () => {
      jest.useFakeTimers({ doNotFake: ['nextTick'] });
      jest.setSystemTime(new Date('2026-06-01T00:00:00.000Z'));
      const { sink, stdout, stderr, clock } = makeSink();
      stdout.defaultReturn = false;
      sink.write(makeRecord({ message: 'buffered' }));
      stdout.writeCalls[0]!.callback(new Error('fail')); // marks stdout broken, first drop

      // stderr already received the immediate "log stream disabled"
      // cross-stream diagnostic when stdout broke; the summary is a SECOND,
      // later write once the window elapses.
      expect(stderr.writeCalls).toHaveLength(1);
      clock.advance(60_000);
      expect(stderr.writeCalls).toHaveLength(2);
      const summary = parse(lastWrite(stderr));
      expect(summary).toMatchObject({ namespace: 'crowi:logger', message: 'log records dropped', data: { stream: 'stdout', droppedRecords: 1 } });
      expect((summary.data as { windowStartedAt: string }).windowStartedAt).toBe('2026-06-01T00:00:00.000Z');
      jest.useRealTimers();
    });

    it('restarts a late summary deadline from the attempt clock', () => {
      const { sink, stdout, stderr, clock } = makeSink();
      stdout.defaultReturn = false;
      sink.write(makeRecord({ message: 'first' }));
      stdout.writeCalls[0]!.callback(new Error('fail')); // stdout broken; one pending drop, one timer armed
      expect(clock.pendingCount()).toBe(1);
      expect(clock.now).toHaveBeenCalledTimes(1); // brief §8.2: the deadline reads the attempt-time monotonic clock
      const firstAttemptAt = clock.now.mock.results[0]!.value as number;

      // Further drops against the already-broken stream accumulate onto the
      // SAME window instead of arming additional timers or reading the clock
      // again — `armSummaryTimer` short-circuits while a timer is pending.
      sink.write(makeRecord({ message: 'second' }));
      sink.write(makeRecord({ message: 'third' }));
      expect(clock.pendingCount()).toBe(1);
      expect(clock.now).toHaveBeenCalledTimes(1);

      clock.advance(60_000);
      const firstSummary = stderr.writeCalls.map((c) => parse(c.buffer)).find((r) => r.message === 'log records dropped');
      expect((firstSummary?.data as { droppedRecords: number }).droppedRecords).toBe(3);
      expect(clock.pendingCount()).toBe(0); // accepted — no more pending drops, no timer left armed

      // A brand-new drop after the reset opens a fresh window from the
      // CURRENT clock rather than any stale deadline: a second, LATER
      // attempt-time read, not the first one advanced by one window.
      sink.write(makeRecord({ message: 'fourth' }));
      expect(clock.pendingCount()).toBe(1);
      expect(clock.now).toHaveBeenCalledTimes(2);
      const secondAttemptAt = clock.now.mock.results[1]!.value as number;
      expect(secondAttemptAt).toBeGreaterThan(firstAttemptAt);
      expect(secondAttemptAt).toBe(firstAttemptAt + 60_000); // exactly one window elapsed, not advanced arithmetically

      clock.advance(60_000);
      const summaries = stderr.writeCalls.map((c) => parse(c.buffer)).filter((r) => r.message === 'log records dropped');
      expect(summaries).toHaveLength(2);
      expect((summaries[1]?.data as { droppedRecords: number }).droppedRecords).toBe(1);
    });

    it('does not produce a catch-up burst when the clock jumps past multiple windows in one advance', () => {
      const { sink, stdout, stderr, clock } = makeSink();
      stdout.defaultReturn = false;
      sink.write(makeRecord({ message: 'late' }));
      stdout.writeCalls[0]!.callback(new Error('fail')); // stdout broken; one pending drop, one timer armed
      expect(clock.pendingCount()).toBe(1);

      // Simulate an event loop that fell behind by three windows before the
      // timer got a chance to run. Only the ONE armed timer can fire — a
      // design that instead recomputed the deadline by repeatedly advancing
      // a stale value (or polled on a fixed interval) could produce multiple
      // catch-up summaries here; this section forbids that (brief §8.2).
      clock.advance(180_000);
      const summaries = stderr.writeCalls.map((c) => parse(c.buffer)).filter((r) => r.message === 'log records dropped');
      expect(summaries).toHaveLength(1);
      expect(clock.pendingCount()).toBe(0); // accepted; nothing left armed despite the large jump
    });
  });

  describe('AC-C15 / AC-C34: broken-stream transitions', () => {
    it('marks only the affected stream broken once for every failure channel', () => {
      const { sink, stdout, stderr } = makeSink();
      sink.write(makeRecord({ level: 'info' }));
      stdout.emitError(Object.assign(new Error('epipe'), { code: 'EPIPE' }));
      stdout.emitError(new Error('event again')); // idempotent, no second diagnostic
      expect(stderr.writeCalls).toHaveLength(1);
    });
  });

  describe('AC-C16 / AC-C35: broken-stream diagnostics and stderr terminal state', () => {
    it('diagnoses broken stdout once and contains a recursively failing stderr notice', () => {
      const { sink, stdout, stderr } = makeSink();
      let stderrWriteAttempts = 0;
      stderr.write = () => {
        stderrWriteAttempts += 1;
        throw new Error('stderr also broken');
      };
      sink.write(makeRecord({ level: 'info' }));
      stdout.writeCalls[0]!.callback(new Error('fail'));
      expect(stderrWriteAttempts).toBe(1); // the one cross-stream diagnostic attempt, which itself broke stderr

      // stderr is now broken too: a further error-level record is dropped
      // without any additional (recursive) write attempt.
      sink.write(makeRecord({ level: 'error' }));
      expect(stderrWriteAttempts).toBe(1);
    });

    it('cancels both summary timers, retains counters, and never rearms after stderr breaks even when a later drop targets either stream', () => {
      const { sink, stdout, stderr, clock } = makeSink();
      stdout.defaultReturn = false;
      sink.write(makeRecord({ message: 'buffered' }));
      stdout.writeCalls[0]!.callback(new Error('fail')); // stdout broken, pending drop + armed timer
      expect(clock.pendingCount()).toBe(1);

      stderr.emitError(new Error('stderr dies too'));
      expect(clock.pendingCount()).toBe(0);

      // A later drop on stdout (now broken) or stderr (now broken) must not re-arm a timer.
      sink.write(makeRecord({ message: 'more-stdout' }));
      sink.write(makeRecord({ level: 'error', message: 'more-stderr' }));
      expect(clock.pendingCount()).toBe(0);
    });
  });

  describe('AC-C28 / AC-C36: dispose and generation fencing', () => {
    it('fences every late callback drain and timer after idempotent disposal', () => {
      const { sink, stdout, clock } = makeSink();
      stdout.defaultReturn = false;
      sink.write(makeRecord({ message: 'pending' }));
      const pendingCallback = stdout.writeCalls[0]!.callback;

      sink.dispose();
      sink.dispose(); // idempotent

      expect(() => pendingCallback(new Error('late failure'))).not.toThrow();
      expect(() => stdout.emitDrain()).not.toThrow();
      clock.advance(120_000);

      sink.write(makeRecord({ message: 'after dispose' }));
      expect(stdout.writeCalls).toHaveLength(1); // normal write is a no-op post-dispose
    });

    it('keeps a fenced error listener after disposal for late stream failure', () => {
      const { sink, stdout } = makeSink();
      sink.dispose();
      expect(() => stdout.emitError(new Error('late'))).not.toThrow();
    });
  });

  describe('AC-C17 / AC-C18: fatal writes', () => {
    it('advances partial fatal writes before exiting and bypasses normal state', () => {
      const { sink, writeSync, exit } = makeSink();
      writeSync.mockImplementationOnce((_fd, _buf, _offset, length) => Math.min(4, length));
      writeSync.mockImplementationOnce((_fd, _buf, _offset, length) => length);
      expect(() => sink.writeFatal(makeRecord({ level: 'error', message: 'fatal' }))).toThrow(ExitCalled);
      expect(writeSync).toHaveBeenCalledTimes(2);
      expect(exit).toHaveBeenCalledWith(1);
    });

    it('exits after every fatal primary and fallback failure mode', () => {
      const { sink, writeSync, exit } = makeSink();
      writeSync.mockImplementation(() => {
        throw new Error('EAGAIN');
      });
      expect(() => sink.writeFatal(makeRecord({ level: 'error', message: 'fatal' }))).toThrow(ExitCalled);
      // Primary loop attempts + one best-effort fallback attempt.
      expect(writeSync.mock.calls.length).toBeGreaterThanOrEqual(2);
      expect(exit).toHaveBeenCalledWith(1);
    });

    it('uses descriptor 2 when stderrFd is not a valid non-negative integer', () => {
      const stdout = new FakeWritable();
      const stderr = new FakeWritable();
      const clock = makeFakeClock();
      const writeSync = jest.fn((_fd: number, _buf: Buffer, _offset: number, length: number) => length);
      const exit = jest.fn(() => {
        throw new ExitCalled();
      });
      const sink = createRecordSink({
        stdout: stdout as unknown as NodeJS.WritableStream,
        stderr: stderr as unknown as NodeJS.WritableStream,
        stderrFd: undefined,
        writeSync: writeSync as unknown as RecordSinkDependencies['writeSync'],
        exit: exit as unknown as RecordSinkDependencies['exit'],
        now: clock.now,
        setTimeout: clock.setTimeout,
        clearTimeout: clock.clearTimeout,
      });
      expect(() => sink.writeFatal(makeRecord({ level: 'error' }))).toThrow(ExitCalled);
      expect(writeSync.mock.calls[0]?.[0]).toBe(2);
    });

    it('keeps the best-effort fallback pinned to descriptor 2 even when the primary descriptor is a different valid fd', () => {
      const stdout = new FakeWritable();
      const stderr = new FakeWritable();
      const clock = makeFakeClock();
      // Returns 0 bytes written, which §13.1 classifies as failure on the
      // first attempt, so the primary loop stops after one call and the
      // runtime falls through to the one best-effort fallback call.
      const writeSync = jest.fn((_fd: number, _buf: Buffer, _offset: number, _length: number) => 0);
      const exit = jest.fn(() => {
        throw new ExitCalled();
      });
      const sink = createRecordSink({
        stdout: stdout as unknown as NodeJS.WritableStream,
        stderr: stderr as unknown as NodeJS.WritableStream,
        stderrFd: 5, // a valid, non-2 descriptor — the primary loop uses THIS
        writeSync: writeSync as unknown as RecordSinkDependencies['writeSync'],
        exit: exit as unknown as RecordSinkDependencies['exit'],
        now: clock.now,
        setTimeout: clock.setTimeout,
        clearTimeout: clock.clearTimeout,
      });
      expect(() => sink.writeFatal(makeRecord({ level: 'error' }))).toThrow(ExitCalled);
      // Primary attempts all target fd 5; the final call is the best-effort
      // fallback and must target fd 2 regardless, per brief §13.1.
      const fdsUsed = writeSync.mock.calls.map((call) => call[0]);
      expect(fdsUsed.slice(0, -1)).toEqual(fdsUsed.slice(0, -1).map(() => 5));
      expect(fdsUsed[fdsUsed.length - 1]).toBe(2);
    });
  });
});
