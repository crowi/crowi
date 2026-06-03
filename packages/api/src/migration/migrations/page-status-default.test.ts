import { crowi } from 'src/test/setup';
import type { MigrationApplicationModel } from 'src/models/migration-application';

import { MigrationRegistry } from '../registry';
import { runBootMigrations } from '../run-boot-migrations';
import { MigrationRunner } from '../runner';
import { pageStatusDefault } from './page-status-default';

/**
 * RFC-0008 §10.1 — `page-status-default` boot migration.
 *
 * Preserves the RFC-0004 backfill semantics formerly covered by
 * `util/page-status-migration.test.ts`: stamp `status='published'` onto
 * legacy null/unset rows only, never rewrite an explicit status (in
 * particular never a `draft`), idempotent. Plus the framework wiring: boot
 * applies it via `isPending`, records to `migrationApplications`, and a
 * second boot reports `detected-clean`.
 */
const MigrationApplication = () => crowi.model('MigrationApplication') as MigrationApplicationModel;

describe('migration/page-status-default', () => {
  let Page;

  beforeAll(() => {
    Page = crowi.model('Page');
  });

  beforeEach(async () => {
    await Page.deleteMany({ path: { $regex: '^/__status-migration' } });
    await MigrationApplication().deleteMany({ migrationId: 'page-status-default' });
  });

  afterEach(async () => {
    await Page.deleteMany({ path: { $regex: '^/__status-migration' } });
  });

  describe('backfill semantics (RFC-0004, behaviour preserved)', () => {
    it('backfills status=published on legacy pages with no status', async () => {
      // Raw collection insert bypasses the schema default that `Page.create`
      // would apply, reproducing a pre-RFC-0004 row.
      await Page.collection.insertMany([
        { path: '/__status-migration/legacy-a', grant: 1 },
        { path: '/__status-migration/legacy-b', grant: 1, status: null },
      ]);

      const runner = new MigrationRunner(crowi);
      const outcome = await runner.apply(pageStatusDefault);

      expect(outcome.result).toBe('applied');
      expect((outcome.stats['backfill-status'] as { transformed: number }).transformed).toBe(2);

      const a = await Page.findOne({ path: '/__status-migration/legacy-a' });
      const b = await Page.findOne({ path: '/__status-migration/legacy-b' });
      expect(a.status).toBe('published');
      expect(b.status).toBe('published');
    });

    it('leaves explicit draft / published untouched and is idempotent', async () => {
      await Page.collection.insertMany([
        { path: '/__status-migration/draft', grant: 1, status: 'draft' },
        { path: '/__status-migration/published', grant: 1, status: 'published' },
      ]);

      // No null rows → not pending → detected-clean, no stage runs.
      const runner = new MigrationRunner(crowi);
      const outcome = await runner.apply(pageStatusDefault);
      expect(outcome.result).toBe('detected-clean');

      const draft = await Page.findOne({ path: '/__status-migration/draft' });
      const published = await Page.findOne({ path: '/__status-migration/published' });
      // The one-way transition rule: a draft must never be flipped.
      expect(draft.status).toBe('draft');
      expect(published.status).toBe('published');
    });

    it('dry-run touches no rows', async () => {
      await Page.collection.insertMany([{ path: '/__status-migration/dry', grant: 1 }]);

      const runner = new MigrationRunner(crowi, { dryRun: true });
      await runner.apply(pageStatusDefault);

      // Read the raw document (the Mongoose schema default would otherwise
      // hydrate a missing `status` to 'published' on `findOne`). The stage
      // no-oped, so the field must still be absent on disk.
      const dry = await Page.collection.findOne({ path: '/__status-migration/dry' });
      expect(dry?.status == null).toBe(true);
      expect(await MigrationApplication().countDocuments({ migrationId: 'page-status-default' })).toBe(0);
    });
  });

  describe('isPending probe', () => {
    it('is pending while a legacy null row exists, clean once backfilled', async () => {
      await Page.collection.insertMany([{ path: '/__status-migration/probe', grant: 1 }]);

      const runner = new MigrationRunner(crowi);
      expect(await runner.isPending(pageStatusDefault)).toBe(true);

      await runner.apply(pageStatusDefault);
      expect(await runner.isPending(pageStatusDefault)).toBe(false);
    });
  });

  describe('boot wiring (§4.2.1)', () => {
    it('boot applies it, records to migrationApplications, and a second boot is detected-clean', async () => {
      await Page.collection.insertMany([{ path: '/__status-migration/boot', grant: 1 }]);

      const registry = new MigrationRegistry([pageStatusDefault]);

      const first = await runBootMigrations(crowi, { registry, policy: 'block' });
      expect(first.appliedBootIds).toEqual(['page-status-default']);

      const recorded = await MigrationApplication().latestFor('page-status-default');
      expect(recorded?.result).toBe('applied');
      expect(recorded?.layer).toBe('boot');
      expect(recorded?.appliedBy).toBe('boot-auto');

      const booted = await Page.findOne({ path: '/__status-migration/boot' });
      expect(booted.status).toBe('published');
      expect(await MigrationApplication().countDocuments({ migrationId: 'page-status-default' })).toBe(1);

      // Second boot: data is now clean and a prior apply is recorded → the
      // §6.2 "consistent" path runs no stage and appends NO new record
      // (still exactly one). The row stays published.
      await runBootMigrations(crowi, { registry, policy: 'block' });
      expect(await MigrationApplication().countDocuments({ migrationId: 'page-status-default' })).toBe(1);
      const stillBooted = await Page.findOne({ path: '/__status-migration/boot' });
      expect(stillBooted.status).toBe('published');
    });
  });
});
