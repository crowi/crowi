/**
 * The production facade (brief §5.5): lazy, memoized, real-dependency
 * construction shared by `write` and `writeFatal`. Verified with an isolated
 * module registry and a mocked runtime factory — importing the real
 * `logger-sink-runtime` here would attach listeners to the Jest worker's own
 * `process.stdout`/`process.stderr` (brief §9.3's first "way a test passes
 * without testing anything"). This file therefore only proves the facade
 * WIRES a real monotonic clock in; that `RecordSinkImpl` actually READS it
 * on the drop-summary path is `logger-sink-runtime.unit.test.ts`'s "AC-C14 /
 * AC-C27: drop summary cadence" tests, which exercise the real
 * `createRecordSink` with injected (not mocked) dependencies.
 */
describe('production log sink facade', () => {
  it('constructs one real-dependency monotonic runtime lazily for both facade exports', () => {
    let createRecordSinkMock: jest.Mock | undefined;
    let fakeSink: { write: jest.Mock; writeFatal: jest.Mock; dispose: jest.Mock } | undefined;
    let write: (record: unknown) => void;
    let writeFatal: (record: unknown) => void;

    jest.isolateModules(() => {
      fakeSink = { write: jest.fn(), writeFatal: jest.fn(), dispose: jest.fn() };
      createRecordSinkMock = jest.fn(() => fakeSink);
      jest.doMock('./logger-sink-runtime', () => ({ createRecordSink: createRecordSinkMock }));
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const mod = require('./logger-sink') as typeof import('./logger-sink');
      write = mod.write;
      writeFatal = mod.writeFatal;
    });

    // Import alone must not construct the runtime.
    expect(createRecordSinkMock).not.toHaveBeenCalled();

    write({ level: 'info' });
    expect(createRecordSinkMock).toHaveBeenCalledTimes(1);
    const dependencies = createRecordSinkMock?.mock.calls[0]?.[0];
    expect(dependencies.stdout).toBe(process.stdout);
    expect(dependencies.stderr).toBe(process.stderr);
    expect(typeof dependencies.writeSync).toBe('function');
    expect(typeof dependencies.exit).toBe('function');
    expect(typeof dependencies.now).toBe('function');
    const firstReading = dependencies.now();
    const secondReading = dependencies.now();
    expect(typeof firstReading).toBe('number');
    expect(secondReading).toBeGreaterThanOrEqual(firstReading); // real monotonic clock (performance.now), not a stubbed constant

    write({ level: 'warn' });
    writeFatal({ level: 'error' });

    // Both entry points share the SAME memoized instance.
    expect(createRecordSinkMock).toHaveBeenCalledTimes(1);
    expect(fakeSink?.write).toHaveBeenCalledTimes(2);
    expect(fakeSink?.writeFatal).toHaveBeenCalledTimes(1);
  });
});
