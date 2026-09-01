import { faker } from '@faker-js/faker';
import mongoose from 'mongoose';
import { crowi, Fixture } from 'src/test/setup';
import { waitForModel } from 'src/test/wait-for-model';

/**
 * feature-page-update-notification — end-to-end fan-out of the UPDATE
 * notification.
 *
 * Everything is driven through `crowi.event('Page').emit('update', ...)`,
 * the SINGLE fan-out point both save paths flow through:
 *   - HTTP saves (`Page.updatePage` → `emit('update', page, user, count, true)`)
 *   - realtime collab saves (`collab/attach.ts` re-emits the identical
 *     `('update', pageDoc, userDoc, bookmarkCount, true)` shape).
 * A passing emit-driven test therefore covers BOTH save paths (AC).
 *
 * The chain under test: events/page.ts onUpdate → Activity.createByPageUpdate
 * → Activity.post('save') watcher fan-out → Notification.upsertByActivity.
 * We assert on the resulting Notification rows because that is what the
 * watcher actually receives.
 */
const ObjectId = mongoose.Types.ObjectId;

// The fan-out is fire-and-forget across several detached Promise chains:
// events/page.ts notifyPageUpdate → Activity.createByPageUpdate → save →
// Activity.post('save') → getNotificationTargetUsers (multiple DB round
// trips) → Notification.upsertByActivity. Under parallel jest workers
// sharing one mongodb-memory-server this chain can take a while, so the
// waits below use a generous tick budget rather than the default.
const MAX_TICKS = 200;

// Drain a generous number of event-loop ticks so the detached chains settle
// before we assert that NOTHING landed (negative assertions).
const drain = async (ticks = MAX_TICKS) => {
  for (let i = 0; i < ticks; i++) await new Promise((resolve) => setImmediate(resolve));
};

// Poll for a document, sharing the generous tick budget above.
const waitFor = <T>(model: ReturnType<typeof crowi.model>, filter: Record<string, unknown>) =>
  waitForModel(model as never, filter as never, MAX_TICKS) as Promise<T | null>;

describe('page UPDATE notification fan-out (events/page.ts)', () => {
  let Notification: ReturnType<typeof crowi.model>;
  let Activity: ReturnType<typeof crowi.model>;
  let Watcher: ReturnType<typeof crowi.model>;
  let User: ReturnType<typeof crowi.model>;
  let pageEvent: ReturnType<typeof crowi.event<'Page'>>;

  // editor = the acting user (excluded from their own fan-out)
  // watcher = WATCH watcher who should receive the notification
  // ignorer = IGNORE opt-out who must NOT receive it
  const editorId = new ObjectId();
  const watcherId = new ObjectId();
  const secondEditorId = new ObjectId();
  const ignorerId = new ObjectId();

  // The set of user ids this block owns. All fan-out (Watcher/Activity/
  // Notification) this block produces is keyed on one of these users, so
  // scoping every cleanup to `{ user: { $in: ownedUserIds } }` resets this
  // block's state WITHOUT wiping other blocks' seed users / fan-out (a broad
  // `User.deleteMany({})` here was the root cause of cross-block 401 flake).
  const ownedUserIds = [editorId, watcherId, secondEditorId, ignorerId];

  // Reset only this block's fan-out rows (keyed on its owned users). Used by
  // every hook so the scoping lives in one place.
  const clearOwnedFanout = () => Promise.all([Watcher, Activity, Notification].map((model) => model.deleteMany({ user: { $in: ownedUserIds } })));
  // Full reset including this block's seed users (setup/teardown only).
  const clearOwned = () => Promise.all([User.deleteMany({ _id: { $in: ownedUserIds } }), clearOwnedFanout()]);

  // A fresh page id per test so the fire-and-forget fan-out from one test
  // (Activity.createByPageUpdate → post('save') → upsertByActivity, which
  // may still be in flight when the next test's beforeEach clears the
  // collections) cannot leak into another test's assertions.
  let pageId: mongoose.Types.ObjectId;
  let publishedPage: { _id: mongoose.Types.ObjectId; status: string };

  const emitBodyUpdate = (page: { _id: mongoose.Types.ObjectId; status: string }, user: { _id: mongoose.Types.ObjectId }) =>
    // 4th arg `true` = revisionCreated (a new body revision was pushed).
    pageEvent.emit('update', page, user, 0, true);

  beforeAll(async () => {
    Notification = crowi.model('Notification');
    Activity = crowi.model('Activity');
    Watcher = crowi.model('Watcher');
    User = crowi.model('User');
    pageEvent = crowi.event('Page');

    // Scope cleanup to this block's owned users (do NOT wipe the shared User
    // table — that deletes other blocks' seed users and causes 401 flake).
    await clearOwned();
    await Fixture.generate('User', [
      { _id: editorId, email: faker.internet.email(), status: User.STATUS_ACTIVE },
      { _id: watcherId, email: faker.internet.email(), status: User.STATUS_ACTIVE },
      { _id: secondEditorId, email: faker.internet.email(), status: User.STATUS_ACTIVE },
      { _id: ignorerId, email: faker.internet.email(), status: User.STATUS_ACTIVE },
    ]);
  });

  afterAll(async () => {
    await clearOwned();
  });

  beforeEach(async () => {
    await clearOwnedFanout();
    pageId = new ObjectId();
    publishedPage = { _id: pageId, status: 'published' };
  });

  it('delivers an UPDATE notification to a WATCH watcher (covers HTTP + collab save paths)', async () => {
    await Watcher.watchByPageId(watcherId, pageId, Watcher.STATUS_WATCH);

    emitBodyUpdate(publishedPage, { _id: editorId });

    const notification = await waitFor<{ status: string }>(Notification, { user: watcherId, target: pageId, action: 'UPDATE' });
    expect(notification).not.toBeNull();
    expect(notification?.status).toBe(Notification.STATUS_UNREAD);
  });

  it('does not notify the editor about their own update', async () => {
    // The editor is also a WATCH watcher (auto-watch would have made them
    // one); the fan-out must still exclude them as the action user.
    await Watcher.watchByPageId(editorId, pageId, Watcher.STATUS_WATCH);
    await Watcher.watchByPageId(watcherId, pageId, Watcher.STATUS_WATCH);

    emitBodyUpdate(publishedPage, { _id: editorId });

    // The watcher's notification proves the fan-out ran; the editor's must
    // be absent (excluded as the action user).
    await waitFor(Notification, { user: watcherId, target: pageId, action: 'UPDATE' });
    await drain();
    expect(await Notification.countDocuments({ user: editorId, target: pageId, action: 'UPDATE' })).toBe(0);
  });

  it('does not notify a user who IGNOREs the page', async () => {
    await Watcher.watchByPageId(watcherId, pageId, Watcher.STATUS_WATCH);
    await Watcher.watchByPageId(ignorerId, pageId, Watcher.STATUS_IGNORE);

    emitBodyUpdate(publishedPage, { _id: editorId });

    await waitFor(Notification, { user: watcherId, target: pageId, action: 'UPDATE' });
    await drain();
    expect(await Notification.countDocuments({ user: ignorerId, target: pageId, action: 'UPDATE' })).toBe(0);
  });

  it('aggregates repeated / multi-editor updates into one notification per recipient, bundling actors', async () => {
    await Watcher.watchByPageId(watcherId, pageId, Watcher.STATUS_WATCH);

    // Two different editors save the same page. Emit sequentially, waiting
    // for each editor's UPDATE Activity to land before firing the next, so
    // the fire-and-forget chains don't race on the per-(user,target,action,
    // createdAt) Activity unique index.
    emitBodyUpdate(publishedPage, { _id: editorId });
    // Wait for the FIRST editor's notification to materialise before firing
    // the second editor's save: otherwise two concurrent upsert(upsert:true)
    // chains can both miss the not-yet-created row and insert two
    // notifications instead of one (the aggregation index is non-unique).
    await waitFor(Notification, { user: watcherId, target: pageId, action: 'UPDATE' });
    emitBodyUpdate(publishedPage, { _id: secondEditorId });
    await waitFor(Activity, { user: secondEditorId, target: pageId, action: 'UPDATE' });

    // The notification's `activities` array is populated asynchronously by
    // the post('save') hook (Activity insert → upsertByActivity), so poll
    // the watcher's notification until both distinct editors are bundled in
    // rather than guessing a fixed delay.
    const actorIdsOf = async (): Promise<Set<string>> => {
      const notification = await Notification.findOne({ user: watcherId, target: pageId, action: 'UPDATE' }).populate({
        path: 'activities',
        populate: { path: 'user' },
      });
      if (!notification) return new Set();
      return new Set(Activity.getActionUsersFromActivities(notification.activities).map((u: { _id: unknown }) => String(u._id)));
    };
    let actorIds = new Set<string>();
    for (let i = 0; i < MAX_TICKS; i++) {
      actorIds = await actorIdsOf();
      if (actorIds.has(String(editorId)) && actorIds.has(String(secondEditorId))) break;
      await new Promise((resolve) => setImmediate(resolve));
    }

    // A single notification per recipient, with both distinct editors
    // bundled as actors (rendered "Aさん他N名" in the UI).
    expect(await Notification.countDocuments({ user: watcherId, target: pageId, action: 'UPDATE' })).toBe(1);
    expect(actorIds.has(String(editorId))).toBe(true);
    expect(actorIds.has(String(secondEditorId))).toBe(true);
  });

  it('does not notify on a soft-delete update (status="deleted")', async () => {
    await Watcher.watchByPageId(watcherId, pageId, Watcher.STATUS_WATCH);

    // Soft-delete flows through emit('update') with status='deleted'; even
    // with the revisionCreated flag it must be skipped by the status guard.
    pageEvent.emit('update', { _id: pageId, status: 'deleted' }, { _id: editorId }, 0, true);

    await drain();
    expect(await Activity.countDocuments({ target: pageId, action: 'UPDATE' })).toBe(0);
    expect(await Notification.countDocuments({ user: watcherId, target: pageId, action: 'UPDATE' })).toBe(0);
  });

  it('does not notify on a rename / metadata-only update (no new revision)', async () => {
    await Watcher.watchByPageId(watcherId, pageId, Watcher.STATUS_WATCH);

    // rename() emits without the revisionCreated flag (2-3 args). No UPDATE
    // activity / notification must be produced.
    pageEvent.emit('update', publishedPage, { _id: editorId });
    pageEvent.emit('update', publishedPage, { _id: editorId }, 0);

    await drain();
    expect(await Activity.countDocuments({ target: pageId, action: 'UPDATE' })).toBe(0);
    expect(await Notification.countDocuments({ user: watcherId, target: pageId, action: 'UPDATE' })).toBe(0);
  });

  it('leaves existing COMMENT / LIKE / MENTION behaviour unchanged', async () => {
    await Watcher.watchByPageId(watcherId, pageId, Watcher.STATUS_WATCH);

    // COMMENT / LIKE still fan out to the watcher; MENTION still skips the
    // watcher fan-out (handled by the per-recipient dispatcher).
    await Activity.createByParameters({ user: editorId, target: pageId, targetModel: 'Page', action: 'COMMENT' });
    await Activity.createByParameters({ user: editorId, target: pageId, targetModel: 'Page', action: 'LIKE' });
    await Activity.createByParameters({ user: editorId, target: pageId, targetModel: 'Page', action: 'MENTION' });

    // Wait for the fire-and-forget COMMENT / LIKE fan-out to land before
    // asserting; MENTION never fans out to watchers, so its absence is the
    // steady state once COMMENT / LIKE have arrived.
    await waitFor(Notification, { user: watcherId, target: pageId, action: 'COMMENT' });
    await waitFor(Notification, { user: watcherId, target: pageId, action: 'LIKE' });
    await drain();

    expect(await Notification.countDocuments({ user: watcherId, target: pageId, action: 'COMMENT' })).toBe(1);
    expect(await Notification.countDocuments({ user: watcherId, target: pageId, action: 'LIKE' })).toBe(1);
    // MENTION is dispatched per-recipient elsewhere, never via watcher fan-out.
    expect(await Notification.countDocuments({ user: watcherId, target: pageId, action: 'MENTION' })).toBe(0);
  });
});
