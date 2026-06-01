import mongoose from 'mongoose';
import { crowi } from 'src/test/setup';
import { waitForModel } from 'src/test/wait-for-model';
import { autoWatchPage } from 'src/util/auto-watch';

/**
 * feature-watch-autosubscribe — unit tests for the auto-watch helper and
 * the pageEvent listener that drives create/edit auto-watch.
 *
 * The helper is the single source of truth for "participation -> WATCH
 * row", shared by the comment handler (synchronous, for `newlyWatching`)
 * and the page event listener (fire-and-forget, for create/edit). These
 * tests pin its IGNORE-respect and idempotency semantics directly, then
 * exercise the listener via `crowi.event('Page').emit(...)` — the SAME
 * entrypoint both the HTTP save (`Page.createPage`/`updatePage`) and the
 * realtime collab save (`collab/attach.ts` re-emit) flow through, so a
 * passing emit-driven test covers both save paths (AC).
 */
const ObjectId = mongoose.Types.ObjectId;

describe('autoWatchPage helper', () => {
  let Watcher: ReturnType<typeof crowi.model>;

  beforeAll(() => {
    Watcher = crowi.model('Watcher');
  });

  afterEach(async () => {
    await Watcher.deleteMany({});
  });

  it('creates a WATCH row and reports newlyWatching=true when no row exists', async () => {
    const user = new ObjectId();
    const page = new ObjectId();

    const result = await autoWatchPage(Watcher, user, page);

    expect(result.newlyWatching).toBe(true);
    const watcher = await Watcher.findOne({ user, target: page });
    expect(watcher).not.toBeNull();
    expect(watcher.status).toBe(Watcher.STATUS_WATCH);
    expect(watcher.targetModel).toBe('Page');
  });

  it('is idempotent: a second call reports newlyWatching=false and creates no duplicate', async () => {
    const user = new ObjectId();
    const page = new ObjectId();

    await autoWatchPage(Watcher, user, page);
    const second = await autoWatchPage(Watcher, user, page);

    expect(second.newlyWatching).toBe(false);
    expect(await Watcher.countDocuments({ user, target: page })).toBe(1);
  });

  it('respects an existing IGNORE row: no-op, newlyWatching=false, status stays IGNORE', async () => {
    const user = new ObjectId();
    const page = new ObjectId();
    await Watcher.watchByPageId(user, page, Watcher.STATUS_IGNORE);

    const result = await autoWatchPage(Watcher, user, page);

    expect(result.newlyWatching).toBe(false);
    const watcher = await Watcher.findOne({ user, target: page });
    expect(watcher.status).toBe(Watcher.STATUS_IGNORE);
  });
});

describe('pageEvent auto-watch listener (create / edit, both save paths)', () => {
  let Watcher: ReturnType<typeof crowi.model>;
  let pageEvent: ReturnType<typeof crowi.event<'Page'>>;

  beforeAll(() => {
    Watcher = crowi.model('Watcher');
    pageEvent = crowi.event('Page');
  });

  afterEach(async () => {
    await Watcher.deleteMany({});
  });

  // The listener is fire-and-forget; poll the event loop until the row
  // appears (shared `waitForModel`) rather than guessing a delay.
  const waitForWatcher = (user: mongoose.Types.ObjectId, page: mongoose.Types.ObjectId) => waitForModel(Watcher, { user, target: page });

  it("emit('create') auto-watches the acting user (HTTP createPage path)", async () => {
    const user = { _id: new ObjectId() };
    const page = { _id: new ObjectId(), status: 'published' };

    pageEvent.emit('create', page, user);

    const watcher = await waitForWatcher(user._id, page._id);
    expect(watcher).not.toBeNull();
    expect(watcher.status).toBe(Watcher.STATUS_WATCH);
  });

  it("emit('update') auto-watches the editor (HTTP updatePage + realtime collab re-emit path)", async () => {
    // `collab/attach.ts` forwards realtime saves by emitting the identical
    // `('update', pageDoc, userDoc, bookmarkCount)` shape, so this single
    // assertion covers both the HTTP and crowi:save edit paths.
    const user = { _id: new ObjectId() };
    const page = { _id: new ObjectId(), status: 'published' };

    pageEvent.emit('update', page, user, 0);

    const watcher = await waitForWatcher(user._id, page._id);
    expect(watcher).not.toBeNull();
    expect(watcher.status).toBe(Watcher.STATUS_WATCH);
  });

  it("does NOT auto-watch on a soft-delete update (status='deleted')", async () => {
    const user = { _id: new ObjectId() };
    const page = { _id: new ObjectId(), status: 'deleted' };

    pageEvent.emit('update', page, user);

    // Give the (would-be) listener a few ticks to run; assert nothing landed.
    for (let i = 0; i < 10; i++) await new Promise((resolve) => setImmediate(resolve));
    expect(await Watcher.countDocuments({ user: user._id, target: page._id })).toBe(0);
  });

  it("does NOT overwrite an existing IGNORE row on emit('update')", async () => {
    const user = { _id: new ObjectId() };
    const page = { _id: new ObjectId(), status: 'published' };
    await Watcher.watchByPageId(user._id, page._id, Watcher.STATUS_IGNORE);

    pageEvent.emit('update', page, user, 0);

    for (let i = 0; i < 10; i++) await new Promise((resolve) => setImmediate(resolve));
    const watcher = await Watcher.findOne({ user: user._id, target: page._id });
    expect(watcher.status).toBe(Watcher.STATUS_IGNORE);
    expect(await Watcher.countDocuments({ user: user._id, target: page._id })).toBe(1);
  });
});
