import { EventEmitter } from 'node:events';
import {
  ANSI,
  type BootLayer,
  createBootReporter,
  formatDuration,
  formatPlainLayerLine,
  formatPlainReadyLine,
  FAIL_MARKER_PREFIX,
  formatFailMarker,
  formatReadyMarker,
  parseFailMarker,
  parseReadyMarker,
  READY_MARKER_PREFIX,
  spinnerFrame,
} from './boot-reporter';

/**
 * Unit coverage for the boot reporter's pure helpers and its non-TTY (plain)
 * output path. The TTY spinner re-draw is terminal-dependent and left to manual
 * smoke; here we assert the grep-able plain lines, the machine-readable marker
 * round-trip, and the DEBUG → plain degrade.
 */

// A minimal write-stream double capturing everything written.
function fakeStream(isTTY: boolean): { stream: NodeJS.WriteStream; output: () => string } {
  const chunks: string[] = [];
  const s = Object.assign(new EventEmitter(), {
    isTTY,
    write(chunk: string) {
      chunks.push(chunk);
      return true;
    },
  });
  return { stream: s as unknown as NodeJS.WriteStream, output: () => chunks.join('') };
}

describe('boot-reporter pure helpers', () => {
  describe('formatDuration', () => {
    it('formats sub-second as ms', () => {
      expect(formatDuration(412)).toBe('412ms');
      expect(formatDuration(0)).toBe('0ms');
      expect(formatDuration(999.6)).toBe('1000ms');
    });
    it('formats >= 1s as fixed seconds', () => {
      expect(formatDuration(1000)).toBe('1.0s');
      expect(formatDuration(1234)).toBe('1.2s');
    });
  });

  describe('readiness marker round-trip', () => {
    it('formats with the stable prefix', () => {
      expect(formatReadyMarker('api', 'http://localhost:4301')).toBe(`${READY_MARKER_PREFIX} api http://localhost:4301`);
    });
    it('parses a bare marker line', () => {
      expect(parseReadyMarker('@@crowi:ready api http://localhost:4301')).toEqual({
        service: 'api',
        url: 'http://localhost:4301',
      });
    });
    it('parses a marker line prefixed by turbo output', () => {
      expect(parseReadyMarker('@crowi/api:dev: @@crowi:ready api http://localhost:4301')).toEqual({
        service: 'api',
        url: 'http://localhost:4301',
      });
    });
    it('returns null for non-marker lines', () => {
      expect(parseReadyMarker('some unrelated log line')).toBeNull();
      expect(parseReadyMarker('@@crowi:ready')).toBeNull();
      expect(parseReadyMarker('@@crowi:ready api')).toBeNull();
    });
  });

  describe('failure marker round-trip', () => {
    it('formats with the stable prefix and collapses the reason to one line', () => {
      expect(formatFailMarker('api', 'Cannot connect to Database Server')).toBe(`${FAIL_MARKER_PREFIX} api Cannot connect to Database Server`);
      // Multi-line / whitespace-heavy reasons collapse so the marker stays on one line.
      expect(formatFailMarker('api', 'boom\n  at foo\n  at bar')).toBe(`${FAIL_MARKER_PREFIX} api boom at foo at bar`);
    });
    it('parses a bare marker line, keeping the full reason', () => {
      expect(parseFailMarker('@@crowi:fail api Cannot connect to Database Server: ECONNREFUSED')).toEqual({
        service: 'api',
        reason: 'Cannot connect to Database Server: ECONNREFUSED',
      });
    });
    it('parses a marker line prefixed by turbo output', () => {
      expect(parseFailMarker('@crowi/api:dev: @@crowi:fail api db down')).toEqual({
        service: 'api',
        reason: 'db down',
      });
    });
    it('parses a marker with no reason', () => {
      expect(parseFailMarker('@@crowi:fail api')).toEqual({ service: 'api', reason: '' });
    });
    it('returns null for non-marker / empty-body lines', () => {
      expect(parseFailMarker('some unrelated log line')).toBeNull();
      expect(parseFailMarker('@@crowi:fail')).toBeNull();
    });
  });

  describe('plain line formatters', () => {
    it('formats a layer line', () => {
      expect(formatPlainLayerLine('core', 412)).toBe('[boot] core ok (412ms)');
    });
    it('formats the ready line', () => {
      expect(formatPlainReadyLine(1234)).toBe('[boot] ready in 1.2s');
    });
  });

  describe('spinnerFrame', () => {
    it('wraps around the frame list', () => {
      expect(spinnerFrame(0)).toBe(spinnerFrame(10));
      expect(typeof spinnerFrame(3)).toBe('string');
    });
  });
});

describe('createBootReporter (non-TTY / plain mode)', () => {
  it('emits one grep-able plain line per layer and a marker on finish', () => {
    const { stream, output } = fakeStream(false);
    const reporter = createBootReporter({ stream, isTTY: false, debugEnabled: false });

    const layers: BootLayer[] = ['core', 'config', 'services', 'server'];
    for (const layer of layers) {
      reporter.beginLayer(layer);
      reporter.endLayer();
    }
    reporter.finish('api', 'http://localhost:4301');

    const out = output();
    for (const layer of layers) {
      expect(out).toContain(`[boot] ${layer} ok (`);
    }
    // No ANSI cursor control in plain mode.
    expect(out).not.toContain(ANSI.hideCursor);
    expect(out).not.toContain(ANSI.clearLine);
    // Marker present on its own line, TTY or not.
    expect(out).toContain(`${READY_MARKER_PREFIX} api http://localhost:4301\n`);
  });

  it('routes note() straight through in plain mode', () => {
    const { stream, output } = fakeStream(false);
    const reporter = createBootReporter({ stream, isTTY: false, debugEnabled: false });
    reporter.beginLayer('services');
    let called = false;
    reporter.note(() => {
      called = true;
    });
    reporter.endLayer();
    expect(called).toBe(true);
    expect(output()).not.toContain(ANSI.clearLine);
  });

  it('degrades a TTY stream to plain mode when DEBUG is enabled', () => {
    const { stream, output } = fakeStream(true);
    const reporter = createBootReporter({ stream, debugEnabled: true });
    reporter.beginLayer('core');
    reporter.endLayer();
    // No spinner/cursor control despite isTTY=true.
    expect(output()).not.toContain(ANSI.hideCursor);
    expect(output()).toContain('[boot] core ok (');
  });
});

describe('createBootReporter (TTY mode)', () => {
  it('uses cursor control and emits the banner + marker', () => {
    const { stream, output } = fakeStream(true);
    const reporter = createBootReporter({ stream, isTTY: true, debugEnabled: false });
    reporter.beginLayer('core');
    reporter.endLayer();
    reporter.finish('api', 'http://localhost:4301');

    const out = output();
    expect(out).toContain(ANSI.hideCursor);
    expect(out).toContain('✓');
    expect(out).toContain('🚀 API ready');
    // Marker still present, separate line.
    expect(out).toContain(`${READY_MARKER_PREFIX} api http://localhost:4301\n`);
  });
});

describe('createBootReporter dispose (failure-path teardown)', () => {
  afterEach(() => {
    jest.useRealTimers();
  });

  it('stops the spinner and restores the cursor when a layer is mid-flight', () => {
    jest.useFakeTimers();
    const { stream, output } = fakeStream(true);
    const reporter = createBootReporter({ stream, isTTY: true, debugEnabled: false });

    reporter.beginLayer('core'); // arms the spinner interval + hides cursor
    jest.advanceTimersByTime(240); // a few spinner frames
    reporter.dispose();

    const out = output();
    // Cursor restored + line cleared so a following stack trace starts clean.
    expect(out).toContain(ANSI.showCursor);
    expect(out).toContain(ANSI.clearLine);

    // After dispose the interval must be dead — no further frames are drawn.
    const before = output().length;
    jest.advanceTimersByTime(800);
    expect(output().length).toBe(before);
  });

  it('is idempotent — a second dispose() is a no-op and re-emits nothing', () => {
    jest.useFakeTimers();
    const { stream, output } = fakeStream(true);
    const reporter = createBootReporter({ stream, isTTY: true, debugEnabled: false });

    reporter.beginLayer('core');
    jest.advanceTimersByTime(160);
    reporter.dispose();
    const afterFirst = output();

    reporter.dispose(); // must be safe + emit nothing more
    expect(output()).toBe(afterFirst);
  });

  it('emits no ANSI when disposing in plain mode', () => {
    const { stream, output } = fakeStream(false);
    const reporter = createBootReporter({ stream, isTTY: false, debugEnabled: false });
    reporter.beginLayer('core');
    reporter.dispose();
    expect(output()).not.toContain(ANSI.showCursor);
    expect(output()).not.toContain(ANSI.clearLine);
  });
});
