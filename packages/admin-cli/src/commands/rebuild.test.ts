import { attachmentDisplayDerivativesExitCode, parseOptionalIsoDate, parsePositiveIntOption, rebuildExitCode } from './rebuild';

/**
 * Regression coverage for the storage-copy exit-code convention (RFC-0008
 * §8.5 / brief: `failed > 0 → exit 2`). `runStorageCopy` accumulates per-key
 * failures into `summary.failed` instead of throwing, so the partial→2 mapping
 * lives entirely in `rebuildExitCode`. A prior version set `process.exitCode = 2`
 * inside the action, which `withRebuildApi`'s explicit `process.exit(0)`
 * silently clobbered — hence asserting the pure mapping here.
 */

/** Build a minimal `RebuildOutcome` carrying just the stats under test. */
function outcome(stats: Record<string, unknown>) {
  return { id: 'storage-copy', durationMs: 1, interrupted: false, stats };
}

describe('rebuildExitCode', () => {
  it('returns 2 when one or more units failed (partial copy)', () => {
    expect(rebuildExitCode(outcome({ ok: 3, failed: 1, skipped: 0, total: 4 }))).toBe(2);
  });

  it('returns 2 when many units failed', () => {
    expect(rebuildExitCode(outcome({ ok: 0, failed: 5, skipped: 0, total: 5 }))).toBe(2);
  });

  it('returns 0 when nothing failed (full success)', () => {
    expect(rebuildExitCode(outcome({ ok: 4, failed: 0, skipped: 0, total: 4 }))).toBe(0);
  });

  it('returns 0 for a dry-run (keys counted as skipped, failed stays 0)', () => {
    expect(rebuildExitCode(outcome({ ok: 0, failed: 0, skipped: 4, total: 4, sampleKeys: ['a', 'b'] }))).toBe(0);
  });

  it('returns 0 when the task reports no `failed` stat at all (e.g. search rebuild)', () => {
    expect(rebuildExitCode(outcome({ driverName: 'elasticsearch', pluginName: '@crowi/plugin-search-elasticsearch' }))).toBe(0);
  });

  it('ignores a non-numeric `failed` value defensively', () => {
    expect(rebuildExitCode(outcome({ failed: 'nope' }))).toBe(0);
  });
});

/**
 * feature-image-derivative-optimization Phase 3 — `attachment-display-derivatives`
 * needs a SIGINT->non-zero-exit AC that neither `rebuildExitCode` nor any
 * sibling command's exit-code mapping covers (see `attachmentDisplayDerivativesExitCode`'s
 * own doc comment). Covered as its own pure-function suite for the same
 * "unit-testable without the boot ceremony" reason as `rebuildExitCode`.
 */
describe('attachmentDisplayDerivativesExitCode', () => {
  function interruptedOutcome(interrupted: boolean, stats: Record<string, unknown> = {}) {
    return { id: 'attachment-display-derivatives', durationMs: 1, interrupted, stats };
  }

  it('returns 130 when the run was interrupted (SIGINT), even with zero failures', () => {
    expect(attachmentDisplayDerivativesExitCode(interruptedOutcome(true, { failed: 0 }))).toBe(130);
  });

  it('returns 130 for an interrupted run REGARDLESS of `failed` count (interrupted takes priority)', () => {
    expect(attachmentDisplayDerivativesExitCode(interruptedOutcome(true, { failed: 3 }))).toBe(130);
  });

  it('falls through to `rebuildExitCode` (2) when not interrupted but items failed', () => {
    expect(attachmentDisplayDerivativesExitCode(interruptedOutcome(false, { failed: 2 }))).toBe(2);
  });

  it('falls through to `rebuildExitCode` (0) when not interrupted and nothing failed', () => {
    expect(attachmentDisplayDerivativesExitCode(interruptedOutcome(false, { failed: 0 }))).toBe(0);
  });
});

describe('parsePositiveIntOption', () => {
  it('parses a plain positive integer string', () => {
    expect(parsePositiveIntOption('2', '--concurrency')).toBe(2);
    expect(parsePositiveIntOption('24', '--gc-grace-hours')).toBe(24);
  });

  it('throws on zero', () => {
    expect(() => parsePositiveIntOption('0', '--concurrency')).toThrow(/--concurrency must be a positive integer/);
  });

  it('throws on a negative number', () => {
    expect(() => parsePositiveIntOption('-1', '--concurrency')).toThrow(/positive integer/);
  });

  it('throws on a non-numeric value', () => {
    expect(() => parsePositiveIntOption('abc', '--concurrency')).toThrow(/positive integer/);
  });

  it('throws on a float (not a plain integer string)', () => {
    expect(() => parsePositiveIntOption('2.5', '--concurrency')).toThrow(/positive integer/);
  });
});

describe('parseOptionalIsoDate', () => {
  it('returns undefined when the raw value is undefined', () => {
    expect(parseOptionalIsoDate(undefined, '--since')).toBeUndefined();
  });

  it('parses a valid ISO 8601 timestamp', () => {
    const parsed = parseOptionalIsoDate('2024-01-01T00:00:00Z', '--since');
    expect(parsed).toBeInstanceOf(Date);
    expect(parsed?.toISOString()).toBe('2024-01-01T00:00:00.000Z');
  });

  it('throws on an unparseable value', () => {
    expect(() => parseOptionalIsoDate('not-a-date', '--until')).toThrow(/--until must be a valid ISO 8601 timestamp/);
  });
});
