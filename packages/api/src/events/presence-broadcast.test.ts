import { EventEmitter } from 'node:events';
import type Crowi from 'src/crowi';
import { _setPresenceServiceForTesting, type CommentChangedPayload, type PageUpdatedPayload, type PresenceService } from 'src/service/presence';
import { registerPresencePageBroadcast } from './presence-broadcast';

/**
 * feature-live-page-content-sync — the boot-registered
 * `pageEvent('update')` → `publishPageUpdated` listener.
 *
 * The listener only touches `crowi.event('Page')`, `crowi.trackSideEffect`
 * and the lazy `getPresenceService(crowi)` (short-circuited here via
 * `_setPresenceServiceForTesting`), so a bare fake crowi with its own
 * EventEmitter suffices — no Mongo, no real presence service, and no
 * leaked listener on the shared test crowi.
 */
describe('events/presence-broadcast (feature-live-page-content-sync)', () => {
  // Distinct emitters per namespace, exactly like the real
  // `crowi.event('Page')` / `crowi.event('Comment')` (each `events[name]`
  // is a separate EventEmitter). Sharing one emitter would let a listener
  // subscribed to the WRONG namespace pass — so the Comment subscription
  // gate (AC#14) is only meaningfully tested with them split.
  let pageEmitter: EventEmitter;
  let commentEmitter: EventEmitter;
  let sideEffects: Array<Promise<unknown>>;
  let published: Array<{ pageId: string; payload: PageUpdatedPayload }>;
  let publishedComments: Array<{ pageId: string; payload: CommentChangedPayload }>;

  /** Await every `trackSideEffect`-registered promise (the async publish). */
  const flush = async (): Promise<void> => {
    await Promise.all(sideEffects);
  };

  const makeRecordingService = (): PresenceService => ({
    async join() {},
    async heartbeat() {
      return true;
    },
    async leave() {},
    async listViewers() {
      return [];
    },
    async markEditing() {},
    async refreshEditing() {},
    async unmarkEditing() {},
    onViewersChanged() {
      return () => {};
    },
    async publishPageUpdated(pageId, payload) {
      published.push({ pageId, payload });
    },
    onPageUpdated() {
      return () => {};
    },
    async publishCommentChanged(pageId, payload) {
      publishedComments.push({ pageId, payload });
    },
    onCommentChanged() {
      return () => {};
    },
    async shutdown() {},
  });

  beforeEach(() => {
    pageEmitter = new EventEmitter();
    commentEmitter = new EventEmitter();
    sideEffects = [];
    published = [];
    publishedComments = [];
    _setPresenceServiceForTesting(makeRecordingService());
    const emitterFor = (name: string): EventEmitter => {
      if (name === 'Page') return pageEmitter;
      if (name === 'Comment') return commentEmitter;
      throw new Error(`unexpected crowi.event('${name}') in presence-broadcast test`);
    };
    const crowi = {
      event: (name: string) => emitterFor(name),
      trackSideEffect: (p: Promise<unknown>) => {
        sideEffects.push(p);
      },
    } as unknown as Crowi;
    registerPresencePageBroadcast(crowi);
  });

  afterEach(() => {
    _setPresenceServiceForTesting(null);
  });

  it('publishes a page-updated signal for a new-revision save (revisionCreated=true)', async () => {
    pageEmitter.emit('update', { _id: 'page-1', status: 'published', revision: { _id: 'rev-2' } }, { _id: 'user-9', name: 'Bob', username: 'bob' }, 0, true);
    await flush();
    expect(published).toEqual([{ pageId: 'page-1', payload: { pageId: 'page-1', revisionId: 'rev-2', editorUserId: 'user-9', editorDisplayName: 'Bob' } }]);
  });

  it('does NOT publish for a rename / metadata-only update (revisionCreated falsy)', async () => {
    pageEmitter.emit('update', { _id: 'page-1', status: 'published', revision: { _id: 'rev-2' } }, { _id: 'user-9', name: 'Bob' });
    await flush();
    expect(published).toEqual([]);
  });

  it('does NOT publish for a soft-delete transition (status=deleted)', async () => {
    pageEmitter.emit('update', { _id: 'page-1', status: 'deleted', revision: { _id: 'rev-2' } }, { _id: 'user-9', name: 'Bob' }, 0, true);
    await flush();
    expect(published).toEqual([]);
  });

  it('falls back to the username when the editor has no display name', async () => {
    pageEmitter.emit('update', { _id: 'page-1', status: 'published', revision: { _id: 'rev-2' } }, { _id: 'user-9', username: 'bob' }, 0, true);
    await flush();
    expect(published[0]?.payload.editorDisplayName).toBe('bob');
  });

  it('resolves a bare ObjectId-like revision reference to its string form', async () => {
    // A defensively-handled shape: `revision` arrives as a value that
    // stringifies to the id rather than a populated `{ _id }` document.
    const revisionRef = { toString: () => 'rev-str' };
    pageEmitter.emit('update', { _id: 'page-1', status: 'published', revision: revisionRef }, { _id: 'user-9', name: 'Bob' }, 0, true);
    await flush();
    expect(published[0]?.payload.revisionId).toBe('rev-str');
  });

  it('skips the broadcast when the revision id is unresolvable', async () => {
    pageEmitter.emit('update', { _id: 'page-1', status: 'published' }, { _id: 'user-9', name: 'Bob' }, 0, true);
    await flush();
    expect(published).toEqual([]);
  });

  // feature-live-page-comment-sync — the Comment 'add' / 'remove'
  // subscriptions registered by the same `registerPresencePageBroadcast`.
  // These emit on the dedicated `commentEmitter`, so they prove the
  // listeners are wired to `crowi.event('Comment')` specifically (a
  // regression that subscribed them to the Page stream would leave these
  // silent — see the namespace-isolation tests below).
  it('publishes a comment-changed(added) signal with the author as actorUserId', async () => {
    commentEmitter.emit('add', { _id: 'comment-1', page: 'page-1', creator: 'user-9' });
    await flush();
    expect(publishedComments).toEqual([
      { pageId: 'page-1', payload: { pageId: 'page-1', changeType: 'added', commentId: 'comment-1', actorUserId: 'user-9' } },
    ]);
  });

  it('publishes a comment-changed(removed) signal WITHOUT an actorUserId', async () => {
    commentEmitter.emit('remove', { _id: 'comment-1', page: 'page-1', creator: 'user-9' });
    await flush();
    expect(publishedComments).toEqual([{ pageId: 'page-1', payload: { pageId: 'page-1', changeType: 'removed', commentId: 'comment-1' } }]);
  });

  it('coerces ObjectId-like page / comment / creator references to strings', async () => {
    const objectIdLike = (id: string) => ({ toString: () => id });
    commentEmitter.emit('add', { _id: objectIdLike('comment-2'), page: objectIdLike('page-2'), creator: objectIdLike('user-2') });
    await flush();
    expect(publishedComments[0]?.payload).toEqual({ pageId: 'page-2', changeType: 'added', commentId: 'comment-2', actorUserId: 'user-2' });
  });

  it('omits actorUserId on add when the creator is missing', async () => {
    commentEmitter.emit('add', { _id: 'comment-3', page: 'page-3' });
    await flush();
    expect(publishedComments[0]?.payload).toEqual({ pageId: 'page-3', changeType: 'added', commentId: 'comment-3' });
    expect(publishedComments[0]?.payload.actorUserId).toBeUndefined();
  });

  it('does NOT publish when the removed comment is null (id did not resolve)', async () => {
    commentEmitter.emit('remove', null);
    await flush();
    expect(publishedComments).toEqual([]);
  });

  it('does NOT publish a comment-changed with an unresolvable pageId', async () => {
    commentEmitter.emit('add', { _id: 'comment-1', creator: 'user-9' });
    await flush();
    expect(publishedComments).toEqual([]);
  });

  // Namespace-isolation gate (AC#14): the comment listeners must be bound
  // to `crowi.event('Comment')` and the page listener to
  // `crowi.event('Page')` — never crossed. A comment-shaped 'add' on the
  // Page stream (or a page 'update' on the Comment stream) must be inert.
  it('does NOT publish a comment-changed for an add on the Page event stream', async () => {
    pageEmitter.emit('add', { _id: 'comment-1', page: 'page-1', creator: 'user-9' });
    await flush();
    expect(publishedComments).toEqual([]);
  });

  it('does NOT publish a comment-changed for a remove on the Page event stream', async () => {
    pageEmitter.emit('remove', { _id: 'comment-1', page: 'page-1' });
    await flush();
    expect(publishedComments).toEqual([]);
  });

  it('does NOT publish a page-updated for an update on the Comment event stream', async () => {
    commentEmitter.emit('update', { _id: 'page-1', status: 'published', revision: { _id: 'rev-2' } }, { _id: 'user-9', name: 'Bob' }, 0, true);
    await flush();
    expect(published).toEqual([]);
  });
});
