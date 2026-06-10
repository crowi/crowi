import faker from 'faker';
import { crowi, Fixture } from 'src/test/setup';

// pageEvent.on('create' | 'update') schedules Backlink.createBySavedPage
// in a microtask; await a few event-loop turns so assertions read the
// settled Mongo state.
// pageEvent.on('create' | 'update') schedules Backlink.createBySavedPage as a
// fire-and-forget chain whose internal awaits produce additional microtasks
// and I/O round-trips. We poll by yielding the event loop until the expected
// Backlink documents appear, with a safety bound.
const waitForBacklinks = async (Backlink, filter, expectedCount, maxTicks = 50) => {
  // Deterministically wait for the tracked fire-and-forget
  // Backlink.createBySavedPage chain (wrapped via crowi.trackSideEffect in the
  // flake-hardening work) to settle, rather than hoping a fixed tick budget
  // outlasts the I/O under parallel load. The poll stays as a backstop.
  await crowi.drainSideEffects();
  for (let i = 0; i < maxTicks; i += 1) {
    const found = await Backlink.find(filter);
    if (found.length === expectedCount) return found;
    await new Promise((resolve) => setImmediate(resolve));
  }
  return Backlink.find(filter);
};

describe('Backlink', () => {
  let Backlink;
  let Page;
  let Revision;
  let user;

  beforeAll(() => {
    Backlink = crowi.model('Backlink');
    Page = crowi.model('Page');
    Revision = crowi.model('Revision');
  });

  beforeAll(async () => {
    const createdUsers = await Fixture.generate('User', [{ name: faker.name.findName(), username: faker.internet.userName(), email: faker.internet.email() }]);
    user = createdUsers[0];
  });

  describe('.createByAllPages', () => {
    beforeAll(async () => {
      await Page.deleteMany({});
      await Revision.deleteMany({});
      const createPath = () => '/' + faker.lorem.slug();
      const createPaths = () => [...Array(3)].map(createPath);
      const createPage = (path, body = 'test') => Page.createPage(path, body, user, {});
      const destPaths = createPaths();
      const srcPaths = createPaths();
      const appUrl = crowi.baseUrl;

      await Promise.all(destPaths.map((path) => createPage(path)));
      const pages = await Promise.all([
        createPage(srcPaths[0], `<${destPaths[0]}>`),
        createPage(srcPaths[1], `[test](${appUrl}${destPaths[1]})`),
        createPage(srcPaths[2], `${appUrl}${destPaths[2]}`),
      ]);

      await Backlink.deleteMany({});
    });

    test('should have all backlinks', async () => {
      const pages = await Backlink.createByAllPages();
      expect(pages).toHaveLength(3);
    });
  });

  describe('via pageEvent hooks', () => {
    const PREFIX = '/backlink-event-test/';

    afterEach(async () => {
      const filter = { path: { $regex: `^${PREFIX}` } };
      const pages = await Page.find(filter).select('_id').lean();
      const pageIds = pages.map((p) => p._id);
      await Promise.all([
        Page.deleteMany(filter),
        Revision.deleteMany(filter),
        Backlink.deleteMany({ $or: [{ page: { $in: pageIds } }, { fromPage: { $in: pageIds } }] }),
      ]);
    });

    test('create event registers backlinks for links found in body', async () => {
      const targetPath = `${PREFIX}target-create`;
      const sourcePath = `${PREFIX}source-create`;

      const target = await Page.createPage(targetPath, '# target', user, {});
      // Source body contains a <path> link to target. The pageEvent.on('create')
      // hook in events/page.ts should call Backlink.createBySavedPage which
      // detects the link and registers a Backlink document.
      const source = await Page.createPage(sourcePath, `link: <${targetPath}>`, user, {});

      const backlinks = await waitForBacklinks(Backlink, { page: target._id }, 1);
      expect(backlinks).toHaveLength(1);
      expect(backlinks[0].fromPage.toString()).toBe(source._id.toString());
    });

    test('update event removes stale backlinks and registers new ones', async () => {
      const t1Path = `${PREFIX}target1-update`;
      const t2Path = `${PREFIX}target2-update`;
      const sourcePath = `${PREFIX}source-update`;

      const t1 = await Page.createPage(t1Path, '# t1', user, {});
      const t2 = await Page.createPage(t2Path, '# t2', user, {});

      // Source initially links only to t1.
      const source = await Page.createPage(sourcePath, `<${t1Path}>`, user, {});

      const initial = await waitForBacklinks(Backlink, { fromPage: source._id }, 1);
      expect(initial).toHaveLength(1);
      expect(initial[0].page.toString()).toBe(t1._id.toString());

      // Replace body so the link to t1 is gone and a new link to t2 appears.
      // Page.updatePage emits 'update' -> events/page.ts -> createBySavedPage
      // (which removes existing fromPage backlinks then re-creates them).
      const updated = await Page.findById(source._id);
      await Page.updatePage(updated, `<${t2Path}>`, user, {});

      // Deterministically wait for the tracked update->createBySavedPage chain
      // (stale-backlink removal then re-create) to settle, same posture as
      // waitForBacklinks' stage-1 drain. Page.updatePage is driven directly
      // (no HTTP), so the test response barrier never runs here — model-direct
      // tests own their own drain (spec section 3). The poll below stays as a
      // backstop for the t1->t2 reference flip.
      await crowi.drainSideEffects();

      // Poll until the backlink points at t2 (the previous t1 link must be
      // removed first then re-created). Length stays at 1 throughout, so we
      // need to inspect the page reference, not just the count.
      let after;
      for (let i = 0; i < 50; i += 1) {
        after = await Backlink.find({ fromPage: source._id });
        if (after.length === 1 && after[0].page.toString() === t2._id.toString()) break;
        await new Promise((resolve) => setImmediate(resolve));
      }
      expect(after).toHaveLength(1);
      expect(after[0].page.toString()).toBe(t2._id.toString());
    });

    test('does not double-register when only the page is saved without content change', async () => {
      // Sanity check: the legacy pageSchema.post('save') hook fired on every
      // .save() call (e.g. status flips, populatePageData side effects).
      // Now that hook is gone, direct .save() with no content change should
      // NOT spawn duplicate backlinks.
      const targetPath = `${PREFIX}target-nodupes`;
      const sourcePath = `${PREFIX}source-nodupes`;

      await Page.createPage(targetPath, '# target', user, {});
      const source = await Page.createPage(sourcePath, `<${targetPath}>`, user, {});

      const before = await waitForBacklinks(Backlink, { fromPage: source._id }, 1);
      expect(before).toHaveLength(1);

      // Touch the page document and save without going through createPage/updatePage.
      const reloaded = await Page.findById(source._id);
      reloaded.commentCount = (reloaded.commentCount || 0) + 1;
      await reloaded.save();
      // Negative check: drain any tracked side effect the bare .save() might
      // schedule (the legacy post-save hook is gone, so nothing should), then
      // assert no duplicate appeared. Draining makes "nothing happens"
      // deterministic instead of relying on a fixed tick budget to outlast a
      // would-be fan-out under parallel load.
      await crowi.drainSideEffects();

      const after = await Backlink.find({ fromPage: source._id });
      expect(after).toHaveLength(1);
    });
  });
});
