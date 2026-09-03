import { faker } from '@faker-js/faker';
import mongoose from 'mongoose';
import { crowi, Fixture, randomUsername } from 'src/test/setup';

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
    const createdUsers = await Fixture.generate('User', [{ name: faker.person.fullName(), username: randomUsername(), email: faker.internet.email() }]);
    user = createdUsers[0];
  });

  describe('.removeByPageIdForHardDelete', () => {
    it("removeByPageIdForHardDelete deletes inbound, outbound, and self-reference rows in exactly one deleteMany call with the $or filter (asserted via jest.spyOn(Backlink, 'deleteMany')), preserves unrelated rows, and is idempotent", async () => {
      const pageId = new mongoose.Types.ObjectId();
      const inboundFromId = new mongoose.Types.ObjectId();
      const outboundToId = new mongoose.Types.ObjectId();
      const revisionId = new mongoose.Types.ObjectId();
      const unrelatedId = new mongoose.Types.ObjectId();

      await Backlink.create({ page: pageId, fromPage: inboundFromId, fromRevision: revisionId }); // inbound: pageId is the link target
      await Backlink.create({ page: outboundToId, fromPage: pageId, fromRevision: revisionId }); // outbound: pageId is the link source
      await Backlink.create({ page: pageId, fromPage: pageId, fromRevision: revisionId }); // self-reference
      await Backlink.create({ page: unrelatedId, fromPage: unrelatedId, fromRevision: revisionId }); // unrelated

      const deleteManySpy = jest.spyOn(Backlink, 'deleteMany');
      let result: { deletedCount: number };
      try {
        result = await Backlink.removeByPageIdForHardDelete(pageId);
        expect(deleteManySpy).toHaveBeenCalledTimes(1);
        expect(deleteManySpy).toHaveBeenCalledWith({ $or: [{ page: pageId }, { fromPage: pageId }] });
      } finally {
        deleteManySpy.mockRestore();
      }

      expect(result).toEqual({ deletedCount: 3 });
      expect(await Backlink.countDocuments({ $or: [{ page: pageId }, { fromPage: pageId }] })).toBe(0);
      expect(await Backlink.countDocuments({ $or: [{ page: unrelatedId }, { fromPage: unrelatedId }] })).toBe(1);

      const rerun = await Backlink.removeByPageIdForHardDelete(pageId);
      expect(rerun).toEqual({ deletedCount: 0 });
    });

    it('removeByPageIdForHardDelete throws without calling deleteMany when pageId is nullish', async () => {
      const deleteManySpy = jest.spyOn(Backlink, 'deleteMany');

      try {
        await expect(Backlink.removeByPageIdForHardDelete(null)).rejects.toThrow(TypeError);
        await expect(Backlink.removeByPageIdForHardDelete(undefined)).rejects.toThrow(TypeError);
        expect(deleteManySpy).not.toHaveBeenCalled();
      } finally {
        deleteManySpy.mockRestore();
      }
    });
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

  // Page.createPage persists the Page first and only then creates its Revision,
  // with no compensating delete if the Revision step fails (models/page.ts) — so
  // a Page with no `revision` survives indefinitely. createByAllPages scans
  // `Page.find({})` unfiltered, so such a Page reaches the rebuild loop.
  describe('.createByAllPages with a revision-less Page', () => {
    beforeEach(async () => {
      await Promise.all([Page.deleteMany({}), Revision.deleteMany({}), Backlink.deleteMany({})]);

      // Inserted FIRST so it sits at index 0 of the unsorted `Page.find({})`
      // result, i.e. the rebuild loop's page lookup always evaluates it.
      await Page.create({
        path: '/' + faker.lorem.slug() + '-orphan',
        creator: user,
        lastUpdateUser: user,
        grant: 1,
        status: 'published',
      });

      const targetPath = '/' + faker.lorem.slug() + '-target';
      await Page.createPage(targetPath, '# target', user, {});
      await Page.createPage('/' + faker.lorem.slug() + '-source', `link: <${targetPath}>`, user, {});

      // `Page.createPage` only emits the create event; the backlink write it
      // schedules is fire-and-forget (events/page.ts registerBacklinks). Without
      // this barrier the delete below can overtake that pending write, leaving a
      // second writer live while a test runs the rebuild — both then delete, and
      // both insert the same source->target row (there is no compound unique
      // index), so the rebuild's count comes out at 2. Draining is exact rather
      // than a tick budget: registerBacklinks puts the deferred promise into the
      // tracked set synchronously, so once these creates return the set already
      // holds them, and drainSideEffects loops until it is empty.
      await crowi.drainSideEffects();
      await Backlink.deleteMany({});
    });

    test('rebuilds instead of crashing on the revision-less Page', async () => {
      await expect(Backlink.createByAllPages()).resolves.toBeDefined();
      expect(await Backlink.countDocuments({})).toBe(1);
    });

    // The test above exercises the real rebuild, but `Page.find({})` is unsorted
    // and MongoDB guarantees no natural order, so it cannot by itself prove the
    // revision-less Page was reached. Pin the exclusion at the query instead:
    // the scan must never hand a revision-less Page to the lookup.
    test('excludes revision-less Pages from the scan rather than relying on scan order', async () => {
      const findSpy = jest.spyOn(Page, 'find');
      try {
        await Backlink.createByAllPages();
        expect(findSpy).toHaveBeenCalled();
        expect(findSpy.mock.calls[0][0]).toEqual({ revision: { $exists: true, $ne: null } });
      } finally {
        findSpy.mockRestore();
      }
    });

    test('does not delete existing backlinks when link resolution throws (resolve-before-delete ordering)', async () => {
      // The property the ordering fix buys: a throw during resolution must
      // leave the previous rows in place. Before the fix `deleteMany` ran
      // first unconditionally, so this ended with zero backlinks and no way
      // back — and this rebuild is itself the documented recovery path.
      // Mirrors the `createBySavedPage` ordering test below.
      await Backlink.createByAllPages();
      expect(await Backlink.countDocuments({})).toBe(1);

      const deleteSpy = jest.spyOn(Backlink, 'deleteMany');
      const realFind = Page.find.bind(Page);
      let findCalls = 0;
      // Call 1 is the page scan; every later call comes from
      // `convertLinksToPageIds`, i.e. the resolution phase.
      const findSpy = jest.spyOn(Page, 'find').mockImplementation((...args) => {
        findCalls += 1;
        if (findCalls === 1) return realFind(...args);
        throw new Error('simulated resolution failure');
      });

      try {
        await expect(Backlink.createByAllPages()).rejects.toThrow('simulated resolution failure');
        expect(deleteSpy).not.toHaveBeenCalled();
        expect(await Backlink.countDocuments({})).toBe(1);
      } finally {
        findSpy.mockRestore();
        deleteSpy.mockRestore();
      }
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

    // --- feature-page-link-space-paths Phase 1 --------------------------

    test('a malformed %-encoded link mixed into the body does not wipe out backlinks from the other, well-formed links', async () => {
      // `linkDetector.search` (link-detector.ts) now wraps each link's
      // decode in a per-link try/catch, so a malformed `%` (e.g. `/a%`,
      // which makes `decodeURIComponent` throw) is skipped without
      // aborting extraction for the rest of the body. Before this fix,
      // `createBySavedPage` ran `removeBySavedPage` BEFORE `linkDetector.search`,
      // so a throw here would have wiped this page's backlinks with
      // nothing to replace them.
      const targetPath = `${PREFIX}target-malformed`;
      const sourcePath = `${PREFIX}source-malformed`;

      const target = await Page.createPage(targetPath, '# target', user, {});
      const source = await Page.createPage(sourcePath, `bad link [bad](/a%) and good link <${targetPath}>`, user, {});

      const backlinks = await waitForBacklinks(Backlink, { page: target._id }, 1);
      expect(backlinks).toHaveLength(1);
      expect(backlinks[0].fromPage.toString()).toBe(source._id.toString());
    });

    test('createBySavedPage does not delete existing backlinks when extraction throws (extract-before-delete ordering)', async () => {
      // Directly pins down the ordering fix: `linkDetector.search` /
      // `convertLinksToPageIds` (extraction) now run BEFORE
      // `Backlink.removeBySavedPage` (deletion). Simulating an extraction
      // failure via a `Page.find` throw (used inside `convertLinksToPageIds`)
      // proves the pre-existing backlinks survive an exception thrown
      // during extraction — before this fix, `removeBySavedPage` ran first
      // unconditionally and would already have deleted them.
      const targetPath = `${PREFIX}target-order`;
      const sourcePath = `${PREFIX}source-order`;

      const target = await Page.createPage(targetPath, '# target', user, {});
      const source = await Page.createPage(sourcePath, `<${targetPath}>`, user, {});

      const before = await waitForBacklinks(Backlink, { fromPage: source._id }, 1);
      expect(before).toHaveLength(1);

      const removeSpy = jest.spyOn(Backlink, 'removeBySavedPage');
      const findSpy = jest.spyOn(Page, 'find').mockImplementationOnce(() => {
        throw new Error('simulated extraction failure');
      });

      try {
        const reloaded = await Page.findById(source._id).populate('revision');
        await expect(Backlink.createBySavedPage(reloaded)).rejects.toThrow('simulated extraction failure');

        expect(removeSpy).not.toHaveBeenCalled();
        const after = await Backlink.find({ fromPage: source._id });
        expect(after).toHaveLength(1);
        expect(after[0].page.toString()).toBe(target._id.toString());
      } finally {
        findSpy.mockRestore();
        removeSpy.mockRestore();
      }
    });

    // --- feature-page-link-space-paths Phase 2 ---------------------------

    test('a raw-space recovered link creates a backlink extracted from revision.meta.rawSpaceLinks — fragment-stripped, +-mixed decode, and malformed-percent-tolerant, all in one save', async () => {
      // `Backlink.createBySavedPage` extracts these from
      // `savedPage.revision.meta.rawSpaceLinks` (feature-backlink-raw-
      // space-metadata — `decodeRawSpaceLinkPaths`), NOT from a new
      // `linkDetector` regex pattern (link-detector.test.ts's matching
      // test pins that `linkDetector.search` itself stays unchanged).
      const target1Path = `${PREFIX}raw space target`;
      const target3Path = `${PREFIX}a b c`;
      const sourcePath = `${PREFIX}source-rawspace`;

      const target1 = await Page.createPage(target1Path, '# t1', user, {});
      const target3 = await Page.createPage(target3Path, '# t3', user, {});

      const body = [
        // Plain raw-space recovery -> backlink to target1.
        `[t1](${target1Path})`,
        // Same target, but with a `#frag` suffix on the recovered `url` —
        // the Phase 1 `stripFragmentAndQuery` helper is reused on this
        // path too, so this must resolve to the SAME target1 (and dedup
        // into a single backlink, not two).
        `[t1frag](${target1Path}#frag)`,
        // `+` mixed with a raw space in the same recovered destination —
        // decoded via the same `stripFragmentAndQuery -> decodeURIComponent
        // -> +->space` pipeline as the regex path, landing on target3's
        // real path (`/a b c`), matching the click-through navigation
        // target exactly.
        `[t3](${PREFIX}a+b c)`,
        // Malformed percent-encoding in a recovered link: `decodeLinkPath`
        // returns null instead of throwing, so this is silently skipped —
        // and must NOT take the other two recovered backlinks down with it.
        `[bad](${PREFIX}a% b)`,
      ].join('\n\n');
      const source = await Page.createPage(sourcePath, body, user, {});

      const backlinks = await waitForBacklinks(Backlink, { fromPage: source._id }, 2);
      expect(backlinks).toHaveLength(2);
      const targetIds = backlinks.map((b) => b.page.toString()).sort();
      expect(targetIds).toEqual([target1._id.toString(), target3._id.toString()].sort());
    });

    test('a raw-space token inside a fenced code block or inline code does not create a false backlink', async () => {
      // `raw-space-links.ts` never descends into `code`/`inlineCode`, so
      // these tokens never contribute a `revision.meta.rawSpaceLinks`
      // entry for `Backlink.createBySavedPage` to pick up — the
      // render/backlink pair stays consistent (neither renders nor
      // backlinks it), unlike the pre-existing regex-detector limitation
      // Phase 1 explicitly declined to fix for the OTHER 3 link forms.
      const targetPath = `${PREFIX}target codefence raw space`;
      const sourcePath = `${PREFIX}source-codefence-rawspace`;

      await Page.createPage(targetPath, '# target', user, {});
      const body = ['```', `[x](${targetPath})`, '```', '', `Inline ${'`'}[y](${targetPath})${'`'} skipped.`].join('\n');
      const source = await Page.createPage(sourcePath, body, user, {});

      await crowi.drainSideEffects();
      const backlinks = await Backlink.find({ fromPage: source._id });
      expect(backlinks).toHaveLength(0);
    });
  });
});
