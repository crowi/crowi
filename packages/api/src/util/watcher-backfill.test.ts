import mongoose from 'mongoose';
import { crowi } from 'src/test/setup';
import { runWatcherBackfill } from 'src/util/watcher-backfill';

/**
 * feature-watch-autosubscribe — backfill tests.
 *
 * Builds a page whose implicit notification set (creator + comment author
 * + revision author) predates auto-watch (we clear the watcher rows the
 * create/edit event listener would have made), then asserts the backfill
 * reconstructs a WATCH row for each participant while respecting an
 * existing IGNORE and leaving existing WATCH rows alone, and is
 * idempotent + dry-run-safe.
 */
const ObjectId = mongoose.Types.ObjectId;

describe('runWatcherBackfill', () => {
  let Page: ReturnType<typeof crowi.model>;
  let Revision: ReturnType<typeof crowi.model>;
  let Comment: ReturnType<typeof crowi.model>;
  let Watcher: ReturnType<typeof crowi.model>;
  let User: ReturnType<typeof crowi.model>;

  beforeAll(() => {
    Page = crowi.model('Page');
    Revision = crowi.model('Revision');
    Comment = crowi.model('Comment');
    Watcher = crowi.model('Watcher');
    User = crowi.model('User');
  });

  afterEach(async () => {
    await Promise.all([Page.deleteMany({}), Revision.deleteMany({}), Comment.deleteMany({}), Watcher.deleteMany({})]);
  });

  /** Make an ACTIVE user so the doc passes any status filters. */
  const makeUser = async (name: string) =>
    (await User.create({
      name,
      username: `${name}-${new ObjectId().toString()}`,
      email: `${name}-${new ObjectId().toString()}@example.com`,
      status: User.STATUS_ACTIVE,
    })) as { _id: mongoose.Types.ObjectId };

  /**
   * A page at `path` whose notification set is { creator, commentAuthor,
   * revisionAuthor }, with NO watcher rows (the pre-auto-watch state).
   */
  const seedPage = async (path: string, creator: mongoose.Types.ObjectId, commentAuthor: mongoose.Types.ObjectId, revisionAuthor: mongoose.Types.ObjectId) => {
    const page = await Page.create({ path, creator });
    // revision author is matched by path (Revision.findAuthorsByPage)
    await Revision.create({ path, body: 'r', format: 'markdown', author: revisionAuthor });
    // comment author is matched by page id (Comment.findCreatorsByPage)
    await Comment.create({ page: page._id, creator: commentAuthor, comment: 'hi' });
    await Watcher.deleteMany({ target: page._id }); // ensure pre-watcher state
    return page;
  };

  it('creates a WATCH row for creator + comment author + revision author', async () => {
    const creator = await makeUser('creator');
    const commenter = await makeUser('commenter');
    const editor = await makeUser('editor');
    const page = await seedPage('/bf/a', creator._id, commenter._id, editor._id);

    const summary = await runWatcherBackfill(crowi);

    expect(summary.dryRun).toBe(false);
    expect(summary.pagesScanned).toBe(1);
    expect(summary.watchersCreated).toBe(3);

    for (const u of [creator, commenter, editor]) {
      const w = await Watcher.findOne({ user: u._id, target: page._id });
      expect(w).not.toBeNull();
      expect(w.status).toBe(Watcher.STATUS_WATCH);
      expect(w.targetModel).toBe('Page');
    }
  });

  it('respects an existing IGNORE and leaves an existing WATCH alone', async () => {
    const creator = await makeUser('creator');
    const commenter = await makeUser('commenter');
    const editor = await makeUser('editor');
    const page = await seedPage('/bf/b', creator._id, commenter._id, editor._id);

    // creator opted out (IGNORE); commenter already explicitly WATCHing.
    await Watcher.create({ user: creator._id, targetModel: 'Page', target: page._id, status: Watcher.STATUS_IGNORE });
    await Watcher.create({ user: commenter._id, targetModel: 'Page', target: page._id, status: Watcher.STATUS_WATCH });

    const summary = await runWatcherBackfill(crowi);

    // only the editor is newly created.
    expect(summary.watchersCreated).toBe(1);
    expect((await Watcher.findOne({ user: creator._id, target: page._id })).status).toBe(Watcher.STATUS_IGNORE);
    expect(await Watcher.countDocuments({ user: commenter._id, target: page._id })).toBe(1);
    expect((await Watcher.findOne({ user: editor._id, target: page._id })).status).toBe(Watcher.STATUS_WATCH);
  });

  it('is idempotent: a second run creates nothing', async () => {
    const creator = await makeUser('creator');
    const commenter = await makeUser('commenter');
    const editor = await makeUser('editor');
    await seedPage('/bf/c', creator._id, commenter._id, editor._id);

    await runWatcherBackfill(crowi);
    const second = await runWatcherBackfill(crowi);

    expect(second.watchersCreated).toBe(0);
  });

  it('dry-run reports the count without writing any rows', async () => {
    const creator = await makeUser('creator');
    const commenter = await makeUser('commenter');
    const editor = await makeUser('editor');
    const page = await seedPage('/bf/d', creator._id, commenter._id, editor._id);

    const summary = await runWatcherBackfill(crowi, { dryRun: true });

    expect(summary.dryRun).toBe(true);
    expect(summary.watchersCreated).toBe(3);
    expect(await Watcher.countDocuments({ target: page._id })).toBe(0);
  });

  it('skips redirect stubs', async () => {
    const creator = await makeUser('creator');
    await Page.create({ path: '/bf/redirect', creator: creator._id, redirectTo: '/bf/target' });

    const summary = await runWatcherBackfill(crowi);

    expect(summary.pagesScanned).toBe(0);
    expect(summary.watchersCreated).toBe(0);
  });
});
