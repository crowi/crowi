import faker from 'faker';
import type { MigrationApplicationModel } from 'src/models/migration-application';
import { crowi, Fixture } from 'src/test/setup';

import { MigrationRegistry } from '../registry';
import { runBootMigrations } from '../run-boot-migrations';
import { MigrationRunner } from '../runner';
import { revisionPageRefBackfill } from './revision-page-ref-backfill';

/**
 * DC-5 / `feature-revision-page-ref` — `revision-page-ref-backfill` boot
 * migration.
 *
 * Legacy (pre-migration) revisions are simulated with `Revision.create(...)`
 * directly (no `page` argument — the schema carries no `default` for it, so
 * this reproduces the on-disk shape of a row written before this feature,
 * same technique `revision.test.ts`'s "v1.x backward compat" describe block
 * already uses).
 */
const MigrationApplication = () => crowi.model('MigrationApplication') as MigrationApplicationModel;

describe('migration/revision-page-ref-backfill', () => {
  let Page;
  let Revision;
  let user;

  const PATH_PREFIX = '/__revpageref-migration';

  beforeAll(async () => {
    Page = crowi.model('Page');
    Revision = crowi.model('Revision');

    const users = await Fixture.generate('User', [{ name: faker.name.findName(), username: faker.internet.userName(), email: faker.internet.email() }]);
    user = users[0];
  });

  const cleanup = async () => {
    await Page.deleteMany({ path: { $regex: `^${PATH_PREFIX}` } });
    await Revision.deleteMany({ path: { $regex: `^${PATH_PREFIX}` } });
    await MigrationApplication().deleteMany({ migrationId: 'revision-page-ref-backfill' });
  };

  beforeEach(cleanup);
  afterEach(cleanup);

  // A bare Page row (no revision) — mirrors `seedPage` in revision.test.ts.
  const seedPage = (path: string) =>
    Page.create({
      path,
      creator: user._id,
      lastUpdateUser: user._id,
      grant: 1,
      status: 'published',
      grantedUsers: [user._id],
    });

  describe('backfill semantics', () => {
    it('backfills page on legacy revisions matched by their page’s current path', async () => {
      const path = `${PATH_PREFIX}/basic`;
      const page = await seedPage(path);
      const rev = await Revision.create({ path, body: 'legacy body', author: user._id, createdAt: new Date() });
      expect((await Revision.findById(rev._id).lean()).page).toBeUndefined();

      const runner = new MigrationRunner(crowi);
      const outcome = await runner.apply(revisionPageRefBackfill);

      expect(outcome.result).toBe('applied');
      expect((outcome.stats['backfill-page-ref'] as { transformed: number }).transformed).toBe(1);

      const fetched = await Revision.findById(rev._id).lean();
      expect(fetched.page?.toString()).toBe(page._id.toString());
    });

    it('backfills every legacy revision across multiple distinct pages in one pass', async () => {
      const pageA = await seedPage(`${PATH_PREFIX}/multi-a`);
      const pageB = await seedPage(`${PATH_PREFIX}/multi-b`);
      const pageC = await seedPage(`${PATH_PREFIX}/multi-c`);

      const [revA1, revA2, revB1, revC1] = await Promise.all([
        Revision.create({ path: pageA.path, body: 'a1', author: user._id }),
        Revision.create({ path: pageA.path, body: 'a2', author: user._id }),
        Revision.create({ path: pageB.path, body: 'b1', author: user._id }),
        Revision.create({ path: pageC.path, body: 'c1', author: user._id }),
      ]);

      const runner = new MigrationRunner(crowi);
      const outcome = await runner.apply(revisionPageRefBackfill);
      expect((outcome.stats['backfill-page-ref'] as { transformed: number }).transformed).toBe(4);

      const [fA1, fA2, fB1, fC1] = await Promise.all([
        Revision.findById(revA1._id).lean(),
        Revision.findById(revA2._id).lean(),
        Revision.findById(revB1._id).lean(),
        Revision.findById(revC1._id).lean(),
      ]);
      expect(fA1.page?.toString()).toBe(pageA._id.toString());
      expect(fA2.page?.toString()).toBe(pageA._id.toString());
      expect(fB1.page?.toString()).toBe(pageB._id.toString());
      expect(fC1.page?.toString()).toBe(pageC._id.toString());
    });

    it('leaves already-backfilled revisions untouched and is idempotent on a second run', async () => {
      const path = `${PATH_PREFIX}/idempotent`;
      const page = await seedPage(path);
      await Revision.create({ path, body: 'legacy', author: user._id });

      const runner = new MigrationRunner(crowi);
      const first = await runner.apply(revisionPageRefBackfill);
      expect((first.stats['backfill-page-ref'] as { transformed: number }).transformed).toBe(1);

      // Not pending anymore, and the first run already recorded 'applied' —
      // the framework's reconciliation (§6.2 "consistent" case) short-
      // circuits to a no-op `stats: {}` without running the stage again
      // (`result` stays 'applied'; 'detected-clean' is reserved for a
      // migration that was NEVER recorded as applied yet finds nothing
      // pending, e.g. a fresh install — see `page-status-default.test.ts`).
      const second = await runner.apply(revisionPageRefBackfill);
      expect(second.result).toBe('applied');
      expect(second.stats).toEqual({});

      const fetched = await Revision.findOne({ path }).lean();
      expect(fetched.page?.toString()).toBe(page._id.toString());
    });

    it('dry-run touches no rows', async () => {
      const path = `${PATH_PREFIX}/dry`;
      await seedPage(path);
      await Revision.create({ path, body: 'legacy', author: user._id });

      const runner = new MigrationRunner(crowi, { dryRun: true });
      await runner.apply(revisionPageRefBackfill);

      const fetched = await Revision.collection.findOne({ path });
      expect(fetched?.page == null).toBe(true);
      expect(await MigrationApplication().countDocuments({ migrationId: 'revision-page-ref-backfill' })).toBe(0);
    });
  });

  describe('rename + delete/recreate edge cases (spec 未確定事項 / reuseTargets)', () => {
    it('backfills a legacy revision created before a rename using the page’s post-rename path', async () => {
      const oldPath = `${PATH_PREFIX}/rename-old`;
      const newPath = `${PATH_PREFIX}/rename-new`;
      const page = await seedPage(oldPath);
      const rev = await Revision.create({ path: oldPath, body: 'pre-rename legacy revision', author: user._id });

      // `Page.rename` still best-effort syncs `revision.path` (kept as a
      // cosmetic display sync — see `models/page.ts`'s `rename` comment), so
      // by the time the migration runs, this legacy revision's on-disk
      // `path` already reads `newPath`.
      await Page.rename(page, newPath, user, {});
      expect((await Revision.findById(rev._id).lean()).path).toBe(newPath);

      const runner = new MigrationRunner(crowi);
      const outcome = await runner.apply(revisionPageRefBackfill);
      expect((outcome.stats['backfill-page-ref'] as { transformed: number }).transformed).toBe(1);

      const fetched = await Revision.findById(rev._id).lean();
      expect(fetched.page?.toString()).toBe(page._id.toString());
    });

    it('does not confuse a deleted page’s revisions with a different page later recreated at the same path', async () => {
      const path = `${PATH_PREFIX}/delete-recreate`;

      // Page A existed at `path` and is hard-deleted the standard way
      // (a path-scoped delete — the mechanism
      // `Page.removePage` used before this migration ever ran), which took
      // its revisions with it. No trace of A's revisions survives to
      // confuse the migration.
      const pageA = await seedPage(path);
      await Revision.create({ path, body: 'page A legacy revision', author: user._id });
      await Revision.deleteMany({ path }).exec();
      await Page.deleteOne({ _id: pageA._id });
      expect(await Revision.countDocuments({ path })).toBe(0);

      // Page B is created fresh at the same path afterwards, with its own
      // legacy (pre-migration) revision.
      const pageB = await seedPage(path);
      const revB = await Revision.create({ path, body: 'page B legacy revision', author: user._id });

      const runner = new MigrationRunner(crowi);
      const outcome = await runner.apply(revisionPageRefBackfill);
      expect((outcome.stats['backfill-page-ref'] as { transformed: number }).transformed).toBe(1);

      const fetched = await Revision.findById(revB._id).lean();
      expect(fetched.page?.toString()).toBe(pageB._id.toString());
      expect(fetched.page?.toString()).not.toBe(pageA._id.toString());
    });

    it('reviewer round-1 #1: does NOT misattribute a stranded revision from an interrupted delete (page row gone, revision cleanup never ran) to a page later recreated at the same path', async () => {
      const path = `${PATH_PREFIX}/interrupted-delete`;

      // Page A existed at `path`, had ONE legacy (pre-migration) revision,
      // and its page row was removed WITHOUT the revision-cleanup step
      // running (unlike the clean case above — this simulates a crash
      // between `Page.deleteOne` and `Revision.removeRevisionsByPageId`,
      // or any raw-collection deviation from `Page.removePage`). A's
      // revision is left behind at `path` with no `page` ref.
      const oldCreatedAt = new Date('2020-01-01T00:00:00.000Z');
      const pageA = await Page.create({
        path,
        creator: user._id,
        lastUpdateUser: user._id,
        grant: 1,
        status: 'published',
        grantedUsers: [user._id],
        createdAt: oldCreatedAt,
      });
      const revA = await Revision.create({
        path,
        body: 'page A legacy revision (deletion interrupted, cleanup never ran)',
        author: user._id,
        createdAt: new Date(oldCreatedAt.getTime() + 1000),
      });
      await Page.deleteOne({ _id: pageA._id }); // interrupted: revision NOT removed

      // Page B is created FRESH at the same path much later — well after
      // A's stranded revision. A naive `{ path, page: { $exists: false } }`
      // backfill (round-1 implementation) would have handed A's revision to
      // B's id; the `createdAt >= page.createdAt` bound must refuse to.
      const newCreatedAt = new Date('2024-01-01T00:00:00.000Z');
      const pageB = await Page.create({
        path,
        creator: user._id,
        lastUpdateUser: user._id,
        grant: 1,
        status: 'published',
        grantedUsers: [user._id],
        createdAt: newCreatedAt,
      });
      const revB = await Revision.create({
        path,
        body: 'page B legacy revision',
        author: user._id,
        createdAt: new Date(newCreatedAt.getTime() + 1000),
      });

      const runner = new MigrationRunner(crowi);
      const outcome = await runner.apply(revisionPageRefBackfill);
      // Only B's own revision is confidently backfilled.
      expect((outcome.stats['backfill-page-ref'] as { transformed: number }).transformed).toBe(1);

      const fetchedA = await Revision.findById(revA._id).lean();
      const fetchedB = await Revision.findById(revB._id).lean();

      expect(fetchedB.page?.toString()).toBe(pageB._id.toString());
      // A's stranded revision is left unresolved (explicit `null`, see the
      // idempotency describe block below) — never guessed to be B's.
      expect(fetchedA.page == null).toBe(true);
    });
  });

  describe('orphan handling (spec 未確定事項 1)', () => {
    it('leaves an orphan revision (path matching no current page) explicitly unresolved (`page: null`) and reports it via stats + warn log', async () => {
      const orphanPath = `${PATH_PREFIX}/orphan-no-page`;
      const orphan = await Revision.create({ path: orphanPath, body: 'orphaned legacy revision', author: user._id });

      const warnSpy = jest.fn();
      const runner = new MigrationRunner(crowi, { logger: { info: jest.fn(), warn: warnSpy, error: jest.fn(), debug: jest.fn() } });
      const outcome = await runner.apply(revisionPageRefBackfill);

      expect((outcome.stats['backfill-page-ref'] as { transformed: number; orphanCount: number }).orphanCount).toBeGreaterThanOrEqual(1);
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining(orphan._id.toString()));

      const fetched = await Revision.collection.findOne({ _id: orphan._id });
      expect(fetched?.page == null).toBe(true);
    });
  });

  describe('idempotency with permanent orphans (reviewer round-1 #2)', () => {
    it('isPending settles to false once an unresolvable row has been triaged, instead of staying pending forever', async () => {
      const orphanPath = `${PATH_PREFIX}/orphan-idempotent`;
      await Revision.create({ path: orphanPath, body: 'permanently orphaned legacy revision', author: user._id });

      const runner = new MigrationRunner(crowi);
      expect(await runner.isPending(revisionPageRefBackfill)).toBe(true);

      await runner.apply(revisionPageRefBackfill);

      // The orphan is triaged (explicit `page: null`, not left `undefined`)…
      const fetched = await Revision.collection.findOne({ path: orphanPath });
      expect(fetched?.page).toBeNull();
      // …so the SAME `{ page: { $exists: false } }` probe the isPending
      // check and the per-run filter both use no longer matches it. Without
      // this, a permanent orphan would keep the migration "pending" (and
      // its stage re-running / re-warning) on every future boot.
      expect(await runner.isPending(revisionPageRefBackfill)).toBe(false);
    });

    it('a second boot with the orphan still present does not re-run the stage, re-warn, or append a new audit row', async () => {
      const orphanPath = `${PATH_PREFIX}/orphan-boot-idempotent`;
      await Revision.create({ path: orphanPath, body: 'permanently orphaned legacy revision', author: user._id });

      const registry = new MigrationRegistry([revisionPageRefBackfill]);
      const warnSpy = jest.fn();
      const logger = { info: jest.fn(), warn: warnSpy, error: jest.fn(), debug: jest.fn() };

      const first = await runBootMigrations(crowi, { registry, policy: 'block', logger });
      expect(first.appliedBootIds).toEqual(['revision-page-ref-backfill']);
      expect(await MigrationApplication().countDocuments({ migrationId: 'revision-page-ref-backfill' })).toBe(1);
      expect(warnSpy).toHaveBeenCalledTimes(1); // the one orphan-report warn from the first (real) run

      warnSpy.mockClear();

      const second = await runBootMigrations(crowi, { registry, policy: 'block', logger });
      expect(second.appliedBootIds).toEqual(['revision-page-ref-backfill']); // still reported "applied" (framework's consistent no-op label)
      // No new audit row and no re-warn — `apply()`'s "not pending +
      // already applied" branch short-circuits before the stage (and its
      // orphan re-scan) ever runs again.
      expect(await MigrationApplication().countDocuments({ migrationId: 'revision-page-ref-backfill' })).toBe(1);
      expect(warnSpy).not.toHaveBeenCalled();
    });
  });

  describe('isPending probe', () => {
    it('is pending while a legacy revision without page exists, clean once backfilled', async () => {
      const path = `${PATH_PREFIX}/probe`;
      await seedPage(path);
      await Revision.create({ path, body: 'legacy', author: user._id });

      const runner = new MigrationRunner(crowi);
      expect(await runner.isPending(revisionPageRefBackfill)).toBe(true);

      await runner.apply(revisionPageRefBackfill);
      expect(await runner.isPending(revisionPageRefBackfill)).toBe(false);
    });
  });

  describe('boot wiring (§4.2.1)', () => {
    it('boot applies it, records to migrationApplications, and a second boot is detected-clean', async () => {
      const path = `${PATH_PREFIX}/boot`;
      const page = await seedPage(path);
      const rev = await Revision.create({ path, body: 'legacy', author: user._id });

      const registry = new MigrationRegistry([revisionPageRefBackfill]);

      const first = await runBootMigrations(crowi, { registry, policy: 'block' });
      expect(first.appliedBootIds).toEqual(['revision-page-ref-backfill']);

      const recorded = await MigrationApplication().latestFor('revision-page-ref-backfill');
      expect(recorded?.result).toBe('applied');
      expect(recorded?.layer).toBe('boot');
      expect(recorded?.appliedBy).toBe('boot-auto');

      const fetched = await Revision.findById(rev._id).lean();
      expect(fetched.page?.toString()).toBe(page._id.toString());
      expect(await MigrationApplication().countDocuments({ migrationId: 'revision-page-ref-backfill' })).toBe(1);

      await runBootMigrations(crowi, { registry, policy: 'block' });
      expect(await MigrationApplication().countDocuments({ migrationId: 'revision-page-ref-backfill' })).toBe(1);
    });
  });
});
