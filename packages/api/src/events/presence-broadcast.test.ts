import { EventEmitter } from 'node:events';
import type Crowi from 'src/crowi';
import { _setPresenceServiceForTesting, type PageUpdatedPayload, type PresenceService } from 'src/service/presence';
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
  let emitter: EventEmitter;
  let sideEffects: Array<Promise<unknown>>;
  let published: Array<{ pageId: string; payload: PageUpdatedPayload }>;

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
    async shutdown() {},
  });

  beforeEach(() => {
    emitter = new EventEmitter();
    sideEffects = [];
    published = [];
    _setPresenceServiceForTesting(makeRecordingService());
    const crowi = {
      event: () => emitter,
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
    emitter.emit('update', { _id: 'page-1', status: 'published', revision: { _id: 'rev-2' } }, { _id: 'user-9', name: 'Bob', username: 'bob' }, 0, true);
    await flush();
    expect(published).toEqual([{ pageId: 'page-1', payload: { pageId: 'page-1', revisionId: 'rev-2', editorUserId: 'user-9', editorDisplayName: 'Bob' } }]);
  });

  it('does NOT publish for a rename / metadata-only update (revisionCreated falsy)', async () => {
    emitter.emit('update', { _id: 'page-1', status: 'published', revision: { _id: 'rev-2' } }, { _id: 'user-9', name: 'Bob' });
    await flush();
    expect(published).toEqual([]);
  });

  it('does NOT publish for a soft-delete transition (status=deleted)', async () => {
    emitter.emit('update', { _id: 'page-1', status: 'deleted', revision: { _id: 'rev-2' } }, { _id: 'user-9', name: 'Bob' }, 0, true);
    await flush();
    expect(published).toEqual([]);
  });

  it('falls back to the username when the editor has no display name', async () => {
    emitter.emit('update', { _id: 'page-1', status: 'published', revision: { _id: 'rev-2' } }, { _id: 'user-9', username: 'bob' }, 0, true);
    await flush();
    expect(published[0]?.payload.editorDisplayName).toBe('bob');
  });

  it('resolves a bare ObjectId-like revision reference to its string form', async () => {
    // A defensively-handled shape: `revision` arrives as a value that
    // stringifies to the id rather than a populated `{ _id }` document.
    const revisionRef = { toString: () => 'rev-str' };
    emitter.emit('update', { _id: 'page-1', status: 'published', revision: revisionRef }, { _id: 'user-9', name: 'Bob' }, 0, true);
    await flush();
    expect(published[0]?.payload.revisionId).toBe('rev-str');
  });

  it('skips the broadcast when the revision id is unresolvable', async () => {
    emitter.emit('update', { _id: 'page-1', status: 'published' }, { _id: 'user-9', name: 'Bob' }, 0, true);
    await flush();
    expect(published).toEqual([]);
  });
});
