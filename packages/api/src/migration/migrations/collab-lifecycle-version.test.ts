import type { MigrationApplicationModel } from 'src/models/migration-application';
import { crowi } from 'src/test/setup';

import { MigrationRegistry } from '../registry';
import { runBootMigrations } from '../run-boot-migrations';
import { MigrationRunner } from '../runner';
import { collabLifecycleVersion } from './collab-lifecycle-version';

/**
 * RFC-0017 Phase 1 §15.1/§16 — `collab-lifecycle-version` boot migration.
 *
 * Same shape as `page-status-default.test.ts`: backfill semantics (only
 * legacy rows missing the field, idempotent, dry-run no-op) plus the
 * framework wiring (boot applies it, records to `migrationApplications`, a
 * second boot is `detected-clean`).
 */
const MigrationApplication = () => crowi.model('MigrationApplication') as MigrationApplicationModel;

describe('migration/collab-lifecycle-version', () => {
  let Page;

  beforeAll(() => {
    Page = crowi.model('Page');
  });

  beforeEach(async () => {
    await Page.deleteMany({ path: { $regex: '^/__collab-epoch-migration' } });
    await MigrationApplication().deleteMany({ migrationId: 'collab-lifecycle-version' });
  });

  afterEach(async () => {
    await Page.deleteMany({ path: { $regex: '^/__collab-epoch-migration' } });
  });

  describe('backfill semantics', () => {
    it('backfills collabLifecycleVersion=0 on legacy pages missing the field', async () => {
      // Raw collection insert bypasses the schema default that `Page.create`
      // would apply, reproducing a pre-RFC-0017 row.
      await Page.collection.insertMany([
        { path: '/__collab-epoch-migration/legacy-a', grant: 1, status: 'published' },
        { path: '/__collab-epoch-migration/legacy-b', grant: 1, status: 'published' },
      ]);

      const runner = new MigrationRunner(crowi);
      const outcome = await runner.apply(collabLifecycleVersion);

      expect(outcome.result).toBe('applied');
      expect((outcome.stats['backfill-collab-lifecycle-version'] as { transformed: number }).transformed).toBe(2);

      const a = await Page.collection.findOne({ path: '/__collab-epoch-migration/legacy-a' });
      const b = await Page.collection.findOne({ path: '/__collab-epoch-migration/legacy-b' });
      expect(a?.collabLifecycleVersion).toBe(0);
      expect(b?.collabLifecycleVersion).toBe(0);
    });

    it('leaves an already-advanced epoch untouched and is idempotent', async () => {
      await Page.collection.insertMany([{ path: '/__collab-epoch-migration/advanced', grant: 1, status: 'published', collabLifecycleVersion: 3 }]);

      // No rows missing the field → not pending → detected-clean, no stage runs.
      const runner = new MigrationRunner(crowi);
      const outcome = await runner.apply(collabLifecycleVersion);
      expect(outcome.result).toBe('detected-clean');

      const advanced = await Page.collection.findOne({ path: '/__collab-epoch-migration/advanced' });
      expect(advanced?.collabLifecycleVersion).toBe(3);
    });

    it('dry-run touches no rows', async () => {
      await Page.collection.insertMany([{ path: '/__collab-epoch-migration/dry', grant: 1, status: 'published' }]);

      const runner = new MigrationRunner(crowi, { dryRun: true });
      await runner.apply(collabLifecycleVersion);

      // Read the raw document (the Mongoose schema default would otherwise
      // hydrate a missing `collabLifecycleVersion` to 0 on `findOne`). The
      // stage no-oped, so the field must still be absent on disk.
      const dry = await Page.collection.findOne({ path: '/__collab-epoch-migration/dry' });
      expect(dry?.collabLifecycleVersion == null).toBe(true);
      expect(await MigrationApplication().countDocuments({ migrationId: 'collab-lifecycle-version' })).toBe(0);
    });
  });

  describe('isPending probe', () => {
    it('is pending while a legacy row is missing the field, clean once backfilled', async () => {
      await Page.collection.insertMany([{ path: '/__collab-epoch-migration/probe', grant: 1, status: 'published' }]);

      const runner = new MigrationRunner(crowi);
      expect(await runner.isPending(collabLifecycleVersion)).toBe(true);

      await runner.apply(collabLifecycleVersion);
      expect(await runner.isPending(collabLifecycleVersion)).toBe(false);
    });
  });

  describe('boot wiring', () => {
    it('boot applies it, records to migrationApplications, and a second boot is detected-clean', async () => {
      await Page.collection.insertMany([{ path: '/__collab-epoch-migration/boot', grant: 1, status: 'published' }]);

      const registry = new MigrationRegistry([collabLifecycleVersion]);

      const first = await runBootMigrations(crowi, { registry, policy: 'block' });
      expect(first.appliedBootIds).toEqual(['collab-lifecycle-version']);

      const recorded = await MigrationApplication().latestFor('collab-lifecycle-version');
      expect(recorded?.result).toBe('applied');
      expect(recorded?.layer).toBe('boot');
      expect(recorded?.appliedBy).toBe('boot-auto');

      const booted = await Page.collection.findOne({ path: '/__collab-epoch-migration/boot' });
      expect(booted?.collabLifecycleVersion).toBe(0);
      expect(await MigrationApplication().countDocuments({ migrationId: 'collab-lifecycle-version' })).toBe(1);

      // Second boot: data is now clean and a prior apply is recorded → the
      // "consistent" path runs no stage and appends NO new record (still
      // exactly one).
      await runBootMigrations(crowi, { registry, policy: 'block' });
      expect(await MigrationApplication().countDocuments({ migrationId: 'collab-lifecycle-version' })).toBe(1);
      const stillBooted = await Page.collection.findOne({ path: '/__collab-epoch-migration/boot' });
      expect(stillBooted?.collabLifecycleVersion).toBe(0);
    });
  });
});
