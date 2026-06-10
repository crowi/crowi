import { rebuildExitCode } from './rebuild';

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
