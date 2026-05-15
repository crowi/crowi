import { runPageStatusMigration } from 'src/util/page-status-migration';
import { crowi } from 'src/test/setup';

/**
 * RFC-0004 Phase 2 — the boot-time backfill that stamps
 * `status='published'` onto legacy pages predating the `Page.status`
 * field. The migration must touch only null/unset rows and never
 * rewrite an explicit status (in particular never a `draft`).
 */
describe('util/page-status-migration', () => {
  let Page;

  beforeAll(() => {
    Page = crowi.model('Page');
  });

  beforeEach(async () => {
    await Page.deleteMany({ path: { $regex: '^/__status-migration' } });
  });

  afterEach(async () => {
    await Page.deleteMany({ path: { $regex: '^/__status-migration' } });
  });

  test('backfills status=published on legacy pages with no status', async () => {
    // `insertMany` with the field omitted reproduces a pre-RFC-0004
    // row. The schema default would apply on `Page.create`, so we
    // bypass it with a raw collection insert.
    await Page.collection.insertMany([
      { path: '/__status-migration/legacy-a', grant: 1 },
      { path: '/__status-migration/legacy-b', grant: 1, status: null },
    ]);

    const modified = await runPageStatusMigration(crowi);
    expect(modified).toBe(2);

    const a = await Page.findOne({ path: '/__status-migration/legacy-a' });
    const b = await Page.findOne({ path: '/__status-migration/legacy-b' });
    expect(a.status).toBe('published');
    expect(b.status).toBe('published');
  });

  test('leaves explicit draft / published statuses untouched and is idempotent', async () => {
    await Page.collection.insertMany([
      { path: '/__status-migration/draft', grant: 1, status: 'draft' },
      { path: '/__status-migration/published', grant: 1, status: 'published' },
    ]);

    const modified = await runPageStatusMigration(crowi);
    expect(modified).toBe(0);

    const draft = await Page.findOne({ path: '/__status-migration/draft' });
    const published = await Page.findOne({ path: '/__status-migration/published' });
    // The one-way transition rule: a draft must never be flipped to
    // published by the migration.
    expect(draft.status).toBe('draft');
    expect(published.status).toBe('published');

    // A second run touches nothing.
    expect(await runPageStatusMigration(crowi)).toBe(0);
  });
});
