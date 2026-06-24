import { crowi } from 'src/test/setup';
import type { MigrationApplicationModel } from 'src/models/migration-application';

import { userUniquePrepare } from './migrations/user-unique-prepare';
import { createRegistry, MigrationRegistry } from './registry';
import { runBootMigrations, PreflightBlockedError } from './run-boot-migrations';
import { MigrationRunner } from './runner';
import { defineMigration, type MigrationContext, type MigrationDefinition } from './types';

/**
 * RFC-0008 — runner reconciliation (§6.2), the boot two-layer split
 * (§4.2.1/§4.2.7), and the migrationApplications audit log (§7). Driven
 * through the booted Crowi harness so the runner builds a real
 * MigrationContext over mongodb-memory-server.
 */

const MigrationApplication = () => crowi.model('MigrationApplication') as MigrationApplicationModel;

// A fixture migration whose `isPending` flips after the (recording) stage
// runs, so we can exercise the "becomes clean after apply" path.
//
// `severity` defaults to 'blocking' so the existing boot-block test
// (`frt-pre-block`) keeps asserting a throw; flipping the default to
// 'cosmetic' would silently turn that into a no-throw (spec §"runner.test.ts
// 再固定").
function pendingOnce(id: string, layer: 'boot' | 'preflight' = 'preflight', severity: 'blocking' | 'cosmetic' = 'blocking') {
  const state = { pending: true, stageRuns: 0 };
  const def: MigrationDefinition = defineMigration({
    id,
    fromVersion: '1.x',
    toVersion: '2.0',
    layer,
    severity,
    description: `fixture ${id}`,
    isPending: async () => state.pending,
    detect: async () => ({ summary: '1 target remaining', counts: { targets: 1 } }),
    stages: [
      {
        name: 'transform',
        fn: async (_ctx: MigrationContext) => {
          state.stageRuns += 1;
          state.pending = false; // the work is now done
          return { name: 'transform', transformed: 1 };
        },
      },
    ],
  });
  return { def, state };
}

beforeEach(async () => {
  await MigrationApplication().deleteMany({});
});

describe('MigrationRunner.apply — reconciliation (§6.2)', () => {
  it('pending + no record → runs stages and records applied', async () => {
    const { def, state } = pendingOnce('frt-applied');
    const runner = new MigrationRunner(crowi);
    const outcome = await runner.apply(def);

    expect(outcome.result).toBe('applied');
    expect(state.stageRuns).toBe(1);
    const latest = await MigrationApplication().latestFor('frt-applied');
    expect(latest?.result).toBe('applied');
    expect(latest?.appliedBy).toMatch(/admin-cli@/);
  });

  it('not pending + no record → records detected-clean and runs no stage', async () => {
    const def = defineMigration({
      id: 'frt-clean',
      fromVersion: '1.x',
      toVersion: '2.0',
      layer: 'preflight',
      severity: 'blocking',
      description: 'clean',
      isPending: async () => false,
      stages: [{ name: 'noop', fn: async () => ({ name: 'noop' }) }],
    });
    const runner = new MigrationRunner(crowi);
    const outcome = await runner.apply(def);

    expect(outcome.result).toBe('detected-clean');
    expect((await MigrationApplication().latestFor('frt-clean'))?.result).toBe('detected-clean');
  });

  it('pending + already applied → re-applies (trusting inspection)', async () => {
    const { def, state } = pendingOnce('frt-reapply');
    // Pre-seed a prior `applied` record while data is still pending.
    await MigrationApplication().record({ migrationId: 'frt-reapply', result: 'applied' });
    state.pending = true;

    const runner = new MigrationRunner(crowi);
    const outcome = await runner.apply(def);

    expect(outcome.result).toBe('re-applied');
    expect(state.stageRuns).toBe(1);
  });

  it('not pending + already applied → consistent no-op, no new record', async () => {
    const def = defineMigration({
      id: 'frt-consistent',
      fromVersion: '1.x',
      toVersion: '2.0',
      layer: 'preflight',
      severity: 'blocking',
      description: 'consistent',
      isPending: async () => false,
      stages: [{ name: 'noop', fn: async () => ({ name: 'noop' }) }],
    });
    await MigrationApplication().record({ migrationId: 'frt-consistent', result: 'applied' });

    const runner = new MigrationRunner(crowi);
    await runner.apply(def);

    // Still exactly one record — no detected-clean was appended.
    expect(await MigrationApplication().countDocuments({ migrationId: 'frt-consistent' })).toBe(1);
  });

  it('dry-run → runs detect, no stages, no record', async () => {
    const { def, state } = pendingOnce('frt-dry');
    const runner = new MigrationRunner(crowi, { dryRun: true });
    const outcome = await runner.apply(def);

    expect(state.stageRuns).toBe(0);
    expect(outcome.stats).toEqual({ targets: 1 });
    expect(await MigrationApplication().countDocuments({ migrationId: 'frt-dry' })).toBe(0);
  });

  it('records failed and rethrows when a stage throws', async () => {
    const def = defineMigration({
      id: 'frt-fail',
      fromVersion: '1.x',
      toVersion: '2.0',
      layer: 'preflight',
      severity: 'blocking',
      description: 'fail',
      isPending: async () => true,
      stages: [
        {
          name: 'boom',
          fn: async () => {
            throw new Error('kaboom');
          },
        },
      ],
    });
    const runner = new MigrationRunner(crowi);
    await expect(runner.apply(def)).rejects.toThrow('kaboom');
    const latest = await MigrationApplication().latestFor('frt-fail');
    expect(latest?.result).toBe('failed');
    expect(latest?.error).toBe('kaboom');
  });
});

describe('MigrationRunner.mapBounded', () => {
  it('processes every item within the concurrency bound', async () => {
    const runner = new MigrationRunner(crowi, { concurrency: 3 });
    const seen: number[] = [];
    const { processed, interrupted } = await runner.mapBounded([1, 2, 3, 4, 5], async (n) => {
      seen.push(n);
    });
    expect(processed).toBe(5);
    expect(interrupted).toBe(false);
    expect(seen.sort()).toEqual([1, 2, 3, 4, 5]);
  });
});

describe('runBootMigrations — two layers (§4.2.1/§4.2.7)', () => {
  it('applies pending boot migrations and records them', async () => {
    const { def, state } = pendingOnce('frt-boot', 'boot');
    const registry = new MigrationRegistry([def]);

    const result = await runBootMigrations(crowi, { registry, policy: 'block' });

    expect(result.appliedBootIds).toEqual(['frt-boot']);
    expect(state.stageRuns).toBe(1);
    expect((await MigrationApplication().latestFor('frt-boot'))?.layer).toBe('boot');
  });

  it('blocks boot (throws) when a preflight migration is pending under block policy', async () => {
    const { def } = pendingOnce('frt-pre-block', 'preflight');
    const registry = new MigrationRegistry([def]);

    await expect(runBootMigrations(crowi, { registry, policy: 'block' })).rejects.toBeInstanceOf(PreflightBlockedError);
  });

  it('warns but continues when policy is warn', async () => {
    const { def } = pendingOnce('frt-pre-warn', 'preflight');
    const registry = new MigrationRegistry([def]);
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);

    const result = await runBootMigrations(crowi, { registry, policy: 'warn' });
    // `frt-pre-warn` is `pendingOnce` default severity='blocking', downgraded
    // to a warning by the warn policy.
    expect(result.pendingBlockingIds).toEqual(['frt-pre-warn']);
    expect(result.pendingCosmeticIds).toEqual([]);
    warn.mockRestore();
  });

  it('is a clean no-op with the empty (Phase 1) registry', async () => {
    const result = await runBootMigrations(crowi, { registry: createRegistry([]), policy: 'block' });
    expect(result.appliedBootIds).toEqual([]);
    expect(result.pendingBlockingIds).toEqual([]);
    expect(result.pendingCosmeticIds).toEqual([]);
  });

  it('does not refuse boot when the only preflight migration is already clean', async () => {
    const def = defineMigration({
      id: 'frt-pre-clean',
      fromVersion: '1.x',
      toVersion: '2.0',
      layer: 'preflight',
      severity: 'blocking',
      description: 'clean preflight',
      isPending: async () => false,
      stages: [],
    });
    const result = await runBootMigrations(crowi, { registry: new MigrationRegistry([def]), policy: 'block' });
    expect(result.pendingBlockingIds).toEqual([]);
    expect(result.pendingCosmeticIds).toEqual([]);
  });

  it('does not block boot when a cosmetic preflight migration is pending under block policy', async () => {
    // BUG 2 fix: a cosmetic migration whose corpus-scan isPending stays true
    // (e.g. wikilink-format re-pending on new content) must NOT refuse boot.
    const { def } = pendingOnce('frt-pre-cosmetic', 'preflight', 'cosmetic');
    const registry = new MigrationRegistry([def]);
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);

    const result = await runBootMigrations(crowi, { registry, policy: 'block' });

    expect(result.pendingCosmeticIds).toEqual(['frt-pre-cosmetic']);
    expect(result.pendingBlockingIds).toEqual([]);
    // The cosmetic-tagged warn-log carries the pending id.
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('cosmetic preflight migration(s) unapplied [frt-pre-cosmetic]'));
    warn.mockRestore();
  });

  it('blocks on blocking but warns on cosmetic when both are pending under block policy', async () => {
    const { def: blockingDef } = pendingOnce('frt-pre-blk', 'preflight', 'blocking');
    const { def: cosmeticDef } = pendingOnce('frt-pre-cos', 'preflight', 'cosmetic');
    const registry = new MigrationRegistry([blockingDef, cosmeticDef]);
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);

    // The cosmetic warn-log fires *before* the throw; the error carries only
    // the blocking id. The result object is not returned on this path.
    await expect(runBootMigrations(crowi, { registry, policy: 'block' })).rejects.toMatchObject({
      name: 'PreflightBlockedError',
      pendingIds: ['frt-pre-blk'],
    });
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('cosmetic preflight migration(s) unapplied [frt-pre-cos]'));
    warn.mockRestore();
  });

  it('warns separately for blocking and cosmetic when both are pending under warn policy', async () => {
    const { def: blockingDef } = pendingOnce('frt-warn-blk', 'preflight', 'blocking');
    const { def: cosmeticDef } = pendingOnce('frt-warn-cos', 'preflight', 'cosmetic');
    const registry = new MigrationRegistry([blockingDef, cosmeticDef]);
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);

    const result = await runBootMigrations(crowi, { registry, policy: 'warn' });

    expect(result.pendingBlockingIds).toEqual(['frt-warn-blk']);
    expect(result.pendingCosmeticIds).toEqual(['frt-warn-cos']);
    // Two distinct warn-logs, one per severity.
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('cosmetic preflight migration(s) unapplied [frt-warn-cos]'));
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('preflight migration(s) unapplied [frt-warn-blk] — data-integrity risk'));
    warn.mockRestore();
  });
});

describe('registered migration severities (regression guard)', () => {
  it('keeps user-unique-prepare classified as blocking (else E11000 re-surfaces)', () => {
    expect(userUniquePrepare.severity).toBe('blocking');
  });
});
