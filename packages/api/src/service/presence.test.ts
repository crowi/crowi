import type Crowi from 'src/crowi';
import {
  _setPresenceServiceForTesting,
  type CommentChangedPayload,
  createPresenceCollabDeps,
  createPresenceService,
  EDITING_HASH_PREFIX,
  EDITING_REFRESH_MS,
  EDITING_TTL_MS,
  type PageUpdatedPayload,
  PRESENCE_COMMENT_CHANGED_CHANNEL,
  PRESENCE_PAGE_UPDATED_CHANNEL,
  PRESENCE_UPDATES_CHANNEL,
  type PresenceRedisClient,
  type PresenceService,
  VIEWER_HASH_PREFIX,
  VIEWER_TTL_MS,
} from './presence';

/**
 * RFC-0005 — presence service tests.
 *
 * Exercises the Redis-backed implementation against a deterministic
 * in-memory fake (`FakeRedis`) so join / leave / dedup / TTL-sweep /
 * editing-hash join / cross-instance pub/sub all run without a live
 * Redis. The in-process (no-Redis) fallback is also covered so the
 * single-instance dev path doesn't silently regress.
 *
 * Bug-fix note: `isEditing` is no longer derived from the RFC-0003
 * editor-cap Set (`crowi:collab:editors:<pageId>`). That Set is a
 * soft concurrency-limit counter with a 24h key TTL whose members can
 * survive an api crash for up to 24h, painting the `✏️` badge on plain
 * viewers. Editing is now its own short-lived hash
 * `crowi:presence:editing:<pageId>` (field `<userId>:<socketId>`,
 * value `lastSeenAt`) that the collab process must keep refreshing.
 */

/**
 * Minimal in-memory node-redis v4 stand-in. One backing store is
 * shared by every `duplicate()`-d client so a subscriber sees what the
 * primary publishes — the fixture for the multi-instance test.
 */
class FakeRedis implements PresenceRedisClient {
  isOpen = true;
  private readonly hashes: Map<string, Map<string, string>>;
  private readonly subscribers: Map<string, Array<(message: string) => void>>;

  constructor(shared?: {
    hashes: Map<string, Map<string, string>>;
    subscribers: Map<string, Array<(message: string) => void>>;
  }) {
    this.hashes = shared?.hashes ?? new Map();
    this.subscribers = shared?.subscribers ?? new Map();
  }

  private hash(key: string): Map<string, string> {
    let h = this.hashes.get(key);
    if (!h) {
      h = new Map();
      this.hashes.set(key, h);
    }
    return h;
  }

  async hSet(key: string, field: string, value: string): Promise<number> {
    const h = this.hash(key);
    const isNew = h.has(field) ? 0 : 1;
    h.set(field, value);
    return isNew;
  }

  async hGet(key: string, field: string): Promise<string | null | undefined> {
    return this.hashes.get(key)?.get(field) ?? null;
  }

  async hGetAll(key: string): Promise<Record<string, string>> {
    const h = this.hashes.get(key);
    if (!h) return {};
    return Object.fromEntries(h.entries());
  }

  async hDel(key: string, field: string | string[]): Promise<number> {
    const h = this.hashes.get(key);
    if (!h) return 0;
    const fields = Array.isArray(field) ? field : [field];
    let removed = 0;
    for (const f of fields) {
      if (h.delete(f)) removed += 1;
    }
    return removed;
  }

  async expire(): Promise<boolean> {
    // TTL is exercised at the application layer (lastHeartbeatAt /
    // lastSeenAt sweep); the fake does not model key expiry.
    return true;
  }

  /** Test helper — seed the editing hash directly for stale-sweep tests. */
  seedEditingHash(key: string, fields: Record<string, number>): void {
    const h = this.hash(key);
    for (const [field, lastSeenAt] of Object.entries(fields)) {
      h.set(field, String(lastSeenAt));
    }
  }

  async publish(channel: string, message: string): Promise<number> {
    const listeners = this.subscribers.get(channel) ?? [];
    for (const listener of listeners) {
      // Deliver synchronously so tests don't need to await a tick.
      listener(message);
    }
    return listeners.length;
  }

  async subscribe(channel: string, listener: (message: string) => void): Promise<void> {
    const listeners = this.subscribers.get(channel) ?? [];
    listeners.push(listener);
    this.subscribers.set(channel, listeners);
  }

  duplicate(): PresenceRedisClient {
    return new FakeRedis({ hashes: this.hashes, subscribers: this.subscribers });
  }

  async connect(): Promise<unknown> {
    return undefined;
  }

  async disconnect(): Promise<unknown> {
    return undefined;
  }
}

const PAGE_A = 'aaaaaaaaaaaaaaaaaaaaaaaa';
const viewer = (userId: string, overrides: Partial<{ username: string; displayName: string; avatarUrl: string | null }> = {}) => ({
  userId,
  username: overrides.username ?? `user-${userId}`,
  displayName: overrides.displayName ?? `User ${userId}`,
  avatarUrl: overrides.avatarUrl ?? null,
});

describe('presence service — Redis-backed (RFC-0005)', () => {
  it('registers a viewer on join and surfaces it in listViewers', async () => {
    const service = await createPresenceService(new FakeRedis());
    await service.join(PAGE_A, viewer('u1'));

    const viewers = await service.listViewers(PAGE_A);
    expect(viewers).toHaveLength(1);
    expect(viewers[0].userId).toBe('u1');
    expect(viewers[0].isEditing).toBe(false);
    await service.shutdown();
  });

  it('removes a viewer on leave and re-broadcasts the change', async () => {
    const service = await createPresenceService(new FakeRedis());
    const changes: string[] = [];
    service.onViewersChanged((pageId) => changes.push(pageId));

    await service.join(PAGE_A, viewer('u1'));
    await service.leave(PAGE_A, 'u1');

    expect(await service.listViewers(PAGE_A)).toHaveLength(0);
    // join + leave each publish a viewer-list change.
    expect(changes.filter((p) => p === PAGE_A).length).toBeGreaterThanOrEqual(2);
    await service.shutdown();
  });

  it('dedupes the same user across multiple tabs to a single viewer entry', async () => {
    const service = await createPresenceService(new FakeRedis());
    // Three "tabs" = three joins for the same userId.
    await service.join(PAGE_A, viewer('u1'));
    await service.join(PAGE_A, viewer('u1'));
    await service.join(PAGE_A, viewer('u1'));

    const viewers = await service.listViewers(PAGE_A);
    expect(viewers).toHaveLength(1);
    expect(viewers[0].userId).toBe('u1');
    await service.shutdown();
  });

  it('preserves the original joinedAt across re-joins (stable avatar ordering)', async () => {
    // Fake timers instead of a real sleep: the re-join must happen at a
    // *different* Date.now() so a regression (joinedAt overwritten) would
    // be observable, without depending on wall-clock timing.
    jest.useFakeTimers();
    try {
      const service = await createPresenceService(new FakeRedis());
      await service.join(PAGE_A, viewer('u1'));
      const firstJoinedAt = (await service.listViewers(PAGE_A))[0].joinedAt;

      jest.advanceTimersByTime(1_000);
      await service.join(PAGE_A, viewer('u1'));
      const secondJoinedAt = (await service.listViewers(PAGE_A))[0].joinedAt;

      expect(secondJoinedAt).toBe(firstJoinedAt);
      await service.shutdown();
    } finally {
      jest.useRealTimers();
    }
  });

  it('heartbeat refreshes a present viewer and reports false for an absent one', async () => {
    const service = await createPresenceService(new FakeRedis());
    await service.join(PAGE_A, viewer('u1'));

    expect(await service.heartbeat(PAGE_A, 'u1')).toBe(true);
    expect(await service.heartbeat(PAGE_A, 'ghost')).toBe(false);
    await service.shutdown();
  });

  it('filters out and sweeps viewers whose last heartbeat is past the TTL', async () => {
    const redis = new FakeRedis();
    const service = await createPresenceService(redis);
    await service.join(PAGE_A, viewer('u1'));

    // Rewrite the stored field with a stale lastHeartbeatAt directly.
    const key = `${VIEWER_HASH_PREFIX}${PAGE_A}`;
    const raw = await redis.hGet(key, 'u1');
    const stale = JSON.parse(raw as string);
    stale.lastHeartbeatAt = Date.now() - VIEWER_TTL_MS - 1_000;
    await redis.hSet(key, 'u1', JSON.stringify(stale));

    expect(await service.listViewers(PAGE_A)).toHaveLength(0);
    // The stale field is swept from the hash as a side effect.
    expect(await redis.hGet(key, 'u1')).toBeNull();
    await service.shutdown();
  });

  it('markEditing writes the editing hash so a viewing editor gets isEditing=true', async () => {
    const redis = new FakeRedis();
    const service = await createPresenceService(redis);

    await service.join(PAGE_A, viewer('u1'));
    await service.join(PAGE_A, viewer('u2'));
    await service.markEditing(PAGE_A, 'u1', 'socket-1');

    const viewers = await service.listViewers(PAGE_A);
    const byId = Object.fromEntries(viewers.map((v) => [v.userId, v.isEditing]));
    expect(byId.u1).toBe(true);
    expect(byId.u2).toBe(false);
    await service.shutdown();
  });

  it('dedupes a user with two editor tabs to a single isEditing viewer', async () => {
    const redis = new FakeRedis();
    const service = await createPresenceService(redis);

    await service.join(PAGE_A, viewer('u1'));
    await service.markEditing(PAGE_A, 'u1', 'socket-1');
    await service.markEditing(PAGE_A, 'u1', 'socket-2');

    const viewers = await service.listViewers(PAGE_A);
    expect(viewers).toHaveLength(1);
    expect(viewers[0].isEditing).toBe(true);

    // Closing one tab leaves the other editing — badge stays.
    await service.unmarkEditing(PAGE_A, 'u1', 'socket-1');
    expect((await service.listViewers(PAGE_A))[0].isEditing).toBe(true);

    // Closing the last tab clears the badge.
    await service.unmarkEditing(PAGE_A, 'u1', 'socket-2');
    expect((await service.listViewers(PAGE_A))[0].isEditing).toBe(false);
    await service.shutdown();
  });

  it('treats a stale editing-hash field as not editing and sweeps it', async () => {
    const redis = new FakeRedis();
    // Seed the editing hash with a field whose lastSeenAt is well past
    // the TTL — the failure mode the bug fix targets (a never-cleaned
    // editing signal from a crashed api process).
    redis.seedEditingHash(`${EDITING_HASH_PREFIX}${PAGE_A}`, {
      'u1:dead-socket': Date.now() - EDITING_TTL_MS - 5_000,
    });
    const service = await createPresenceService(redis);

    await service.join(PAGE_A, viewer('u1'));

    const viewers = await service.listViewers(PAGE_A);
    expect(viewers[0].isEditing).toBe(false);
    // The stale field is swept from the editing hash as a side effect.
    expect(await redis.hGet(`${EDITING_HASH_PREFIX}${PAGE_A}`, 'u1:dead-socket')).toBeNull();
    await service.shutdown();
  });

  it('refreshEditing keeps a signal fresh but does NOT publish a viewer-list change', async () => {
    const redis = new FakeRedis();
    const publishSpy = jest.spyOn(redis, 'publish');
    const service = await createPresenceService(redis);

    await service.markEditing(PAGE_A, 'u1', 'socket-1');
    const afterMark = publishSpy.mock.calls.filter(([, msg]) => msg === PAGE_A).length;

    await service.refreshEditing(PAGE_A, 'u1', 'socket-1');
    await service.refreshEditing(PAGE_A, 'u1', 'socket-1');

    // markEditing publishes once; refreshEditing publishes never.
    expect(afterMark).toBe(1);
    expect(publishSpy.mock.calls.filter(([, msg]) => msg === PAGE_A)).toHaveLength(1);
    // The signal is still present after the refreshes.
    await service.join(PAGE_A, viewer('u1'));
    expect((await service.listViewers(PAGE_A))[0].isEditing).toBe(true);
    await service.shutdown();
  });

  it('markEditing / unmarkEditing publish a viewer-list change for the badge', async () => {
    const redis = new FakeRedis();
    const publishSpy = jest.spyOn(redis, 'publish');
    const service = await createPresenceService(redis);
    const changes: string[] = [];
    service.onViewersChanged((pageId) => changes.push(pageId));

    await service.markEditing(PAGE_A, 'u1', 'socket-1');
    await service.unmarkEditing(PAGE_A, 'u1', 'socket-1');

    // Each call publishes the pageId on the updates channel exactly
    // once. (The local handler also re-broadcasts via the pub/sub
    // round-trip, so `changes` is observed more than twice — that
    // redundant local broadcast sends an identical viewer list and is
    // harmless; the publish *count* is the precise contract.)
    expect(publishSpy.mock.calls.filter(([, msg]) => msg === PAGE_A)).toHaveLength(2);
    expect(changes.filter((p) => p === PAGE_A).length).toBeGreaterThanOrEqual(2);
    await service.shutdown();
  });

  it('fans a join out to a second instance via the pub/sub channel', async () => {
    // Two services backed by the *same* shared Redis store = two api
    // instances behind a load balancer.
    const sharedRedis = new FakeRedis();
    const instanceA = await createPresenceService(sharedRedis);
    const instanceB = await createPresenceService(sharedRedis);

    const seenByB: string[] = [];
    instanceB.onViewersChanged((pageId) => seenByB.push(pageId));

    // A viewer joins on instance A.
    await instanceA.join(PAGE_A, viewer('u1'));

    // Instance B's subscriber received the pub/sub notification.
    expect(seenByB).toContain(PAGE_A);
    // ...and B can read the viewer A wrote to shared Redis.
    expect(await instanceB.listViewers(PAGE_A)).toHaveLength(1);

    await instanceA.shutdown();
    await instanceB.shutdown();
  });

  it('an editing signal written on one instance is visible on another', async () => {
    const sharedRedis = new FakeRedis();
    const instanceA = await createPresenceService(sharedRedis);
    const instanceB = await createPresenceService(sharedRedis);

    await instanceA.join(PAGE_A, viewer('u1'));
    await instanceA.markEditing(PAGE_A, 'u1', 'socket-1');

    expect((await instanceB.listViewers(PAGE_A))[0].isEditing).toBe(true);

    await instanceA.shutdown();
    await instanceB.shutdown();
  });

  it('publishes joins on the documented pub/sub channel name', async () => {
    const redis = new FakeRedis();
    const publishSpy = jest.spyOn(redis, 'publish');
    const service = await createPresenceService(redis);

    await service.join(PAGE_A, viewer('u1'));

    expect(publishSpy).toHaveBeenCalledWith(PRESENCE_UPDATES_CHANNEL, PAGE_A);
    await service.shutdown();
  });
});

/**
 * feature-live-page-content-sync — read-side soft-refresh fan-out.
 * `publishPageUpdated` rides a *dedicated* Redis channel (JSON payload)
 * distinct from the viewer-list channel (bare pageId), driven by a
 * second subscriber client so the two never cross-contaminate.
 */
describe('presence service — page-updated fan-out (feature-live-page-content-sync)', () => {
  const payload = (overrides: Partial<PageUpdatedPayload> = {}): PageUpdatedPayload => ({
    pageId: PAGE_A,
    revisionId: 'rev-1',
    editorUserId: 'u1',
    editorDisplayName: 'User One',
    ...overrides,
  });

  it('publishes page-updated on the dedicated JSON channel (not the viewer-list channel)', async () => {
    const redis = new FakeRedis();
    const publishSpy = jest.spyOn(redis, 'publish');
    const service = await createPresenceService(redis);

    const p = payload();
    await service.publishPageUpdated(PAGE_A, p);

    expect(publishSpy).toHaveBeenCalledWith(PRESENCE_PAGE_UPDATED_CHANNEL, JSON.stringify(p));
    // The viewer-list channel is untouched by a page-updated publish.
    expect(publishSpy.mock.calls.some(([ch]) => ch === PRESENCE_UPDATES_CHANNEL)).toBe(false);
    await service.shutdown();
  });

  it('opens a second subscriber and disconnects BOTH subscribers on shutdown', async () => {
    const primary = new FakeRedis();
    const dups: FakeRedis[] = [];
    const realDuplicate = FakeRedis.prototype.duplicate;
    jest.spyOn(primary, 'duplicate').mockImplementation(function (this: FakeRedis) {
      const d = realDuplicate.call(this) as FakeRedis;
      dups.push(d);
      return d;
    });

    const service = await createPresenceService(primary);
    // One subscriber for the viewer-list channel, one for page-updated.
    expect(dups).toHaveLength(2);
    const disconnectSpies = dups.map((d) => jest.spyOn(d, 'disconnect'));

    await service.shutdown();
    for (const spy of disconnectSpies) {
      expect(spy).toHaveBeenCalled();
    }
  });

  it('fans a page-updated signal out to a second instance via the dedicated channel', async () => {
    const shared = new FakeRedis();
    const instanceA = await createPresenceService(shared);
    const instanceB = await createPresenceService(shared);

    const seenByB: Array<{ pageId: string; payload: PageUpdatedPayload }> = [];
    instanceB.onPageUpdated((pageId, p) => seenByB.push({ pageId, payload: p }));

    const p = payload();
    await instanceA.publishPageUpdated(PAGE_A, p);

    // B's dedicated subscriber parsed the JSON payload and re-emitted it.
    expect(seenByB).toContainEqual({ pageId: PAGE_A, payload: p });

    await instanceA.shutdown();
    await instanceB.shutdown();
  });

  it('double-delivers to the ORIGIN instance (local emit + Redis loopback) — client debounce dedupes', async () => {
    // Documented harmless double-send (spec §"double-send"): the origin
    // gets the frame from its own local emit AND from the Redis loopback
    // to its own subscriber, so a viewer on the origin sees it twice. The
    // client's debounce + createdAt monotonicity guard collapse it.
    const shared = new FakeRedis();
    const origin = await createPresenceService(shared);
    const seen: PageUpdatedPayload[] = [];
    origin.onPageUpdated((_pageId, p) => seen.push(p));

    await origin.publishPageUpdated(PAGE_A, payload());

    expect(seen).toHaveLength(2);
    await origin.shutdown();
  });
});

/**
 * feature-live-page-comment-sync — live comment fan-out. `publishComment
 * Changed` rides a THIRD dedicated channel (JSON payload) but does NOT
 * open a third subscriber client: it piggybacks the page-updated
 * subscriber's `dup` as a second channel, so the two subscriber
 * connections stay at two.
 */
describe('presence service — comment-changed fan-out (feature-live-page-comment-sync)', () => {
  const payload = (overrides: Partial<CommentChangedPayload> = {}): CommentChangedPayload => ({
    pageId: PAGE_A,
    changeType: 'added',
    commentId: 'comment-1',
    actorUserId: 'u1',
    ...overrides,
  });

  it('publishes comment-changed on its own channel (not viewer-list, not page-updated)', async () => {
    const redis = new FakeRedis();
    const publishSpy = jest.spyOn(redis, 'publish');
    const service = await createPresenceService(redis);

    const p = payload();
    await service.publishCommentChanged(PAGE_A, p);

    expect(publishSpy).toHaveBeenCalledWith(PRESENCE_COMMENT_CHANGED_CHANNEL, JSON.stringify(p));
    expect(publishSpy.mock.calls.some(([ch]) => ch === PRESENCE_UPDATES_CHANNEL)).toBe(false);
    expect(publishSpy.mock.calls.some(([ch]) => ch === PRESENCE_PAGE_UPDATED_CHANNEL)).toBe(false);
    await service.shutdown();
  });

  it('subscribes comment-changed WITHOUT opening a third subscriber client', async () => {
    const primary = new FakeRedis();
    const dups: FakeRedis[] = [];
    const realDuplicate = FakeRedis.prototype.duplicate;
    jest.spyOn(primary, 'duplicate').mockImplementation(function (this: FakeRedis) {
      const d = realDuplicate.call(this) as FakeRedis;
      dups.push(d);
      return d;
    });

    const service = await createPresenceService(primary);
    // Exactly two subscriber clients — viewer-list + the shared
    // page-updated/comment-changed one. Piggybacking the comment-changed
    // channel must NOT add a third connection.
    expect(dups).toHaveLength(2);
    // The comment-changed subscribe landed on one of those two dups, so a
    // cross-instance publish still reaches a listener on this service.
    const seen: CommentChangedPayload[] = [];
    service.onCommentChanged((_pageId, p) => seen.push(p));
    await service.publishCommentChanged(PAGE_A, payload());
    expect(seen.length).toBeGreaterThanOrEqual(1);
    await service.shutdown();
  });

  it('fans a comment-changed out to a second instance via the dedicated channel', async () => {
    const shared = new FakeRedis();
    const instanceA = await createPresenceService(shared);
    const instanceB = await createPresenceService(shared);

    const seenByB: Array<{ pageId: string; payload: CommentChangedPayload }> = [];
    instanceB.onCommentChanged((pageId, p) => seenByB.push({ pageId, payload: p }));

    const p = payload();
    await instanceA.publishCommentChanged(PAGE_A, p);

    expect(seenByB).toContainEqual({ pageId: PAGE_A, payload: p });

    await instanceA.shutdown();
    await instanceB.shutdown();
  });

  it('carries a removed frame with no actorUserId across instances', async () => {
    const shared = new FakeRedis();
    const instanceA = await createPresenceService(shared);
    const instanceB = await createPresenceService(shared);

    const seenByB: CommentChangedPayload[] = [];
    instanceB.onCommentChanged((_pageId, p) => seenByB.push(p));

    const removed = payload({ changeType: 'removed', commentId: 'comment-9', actorUserId: undefined });
    await instanceA.publishCommentChanged(PAGE_A, removed);

    expect(seenByB).toHaveLength(1);
    expect(seenByB[0].changeType).toBe('removed');
    expect(seenByB[0].actorUserId).toBeUndefined();

    await instanceA.shutdown();
    await instanceB.shutdown();
  });

  it('double-delivers to the ORIGIN instance (local emit + Redis loopback)', async () => {
    const shared = new FakeRedis();
    const origin = await createPresenceService(shared);
    const seen: CommentChangedPayload[] = [];
    origin.onCommentChanged((_pageId, p) => seen.push(p));

    await origin.publishCommentChanged(PAGE_A, payload());

    // Client-side invalidate → re-fetch is idempotent and the seen-set
    // highlight diff yields no new id the second time, so the double
    // delivery is harmless — but the transport DOES deliver twice.
    expect(seen).toHaveLength(2);
    await origin.shutdown();
  });

  it('disconnecting the shared second subscriber closes the comment-changed channel too', async () => {
    const primary = new FakeRedis();
    const dups: FakeRedis[] = [];
    const realDuplicate = FakeRedis.prototype.duplicate;
    jest.spyOn(primary, 'duplicate').mockImplementation(function (this: FakeRedis) {
      const d = realDuplicate.call(this) as FakeRedis;
      dups.push(d);
      return d;
    });

    const service = await createPresenceService(primary);
    expect(dups).toHaveLength(2);
    const disconnectSpies = dups.map((d) => jest.spyOn(d, 'disconnect'));

    await service.shutdown();
    for (const spy of disconnectSpies) {
      expect(spy).toHaveBeenCalled();
    }
  });
});

describe('presence service — in-process fallback (no Redis)', () => {
  it('tracks viewers without Redis and dedupes multi-tab', async () => {
    const service = await createPresenceService(null);
    await service.join(PAGE_A, viewer('u1'));
    await service.join(PAGE_A, viewer('u1'));
    await service.join(PAGE_A, viewer('u2'));

    const viewers = await service.listViewers(PAGE_A);
    expect(viewers.map((v) => v.userId).sort()).toEqual(['u1', 'u2']);
    // No editing signal yet.
    expect(viewers.every((v) => v.isEditing === false)).toBe(true);
    await service.shutdown();
  });

  it('tracks an editing signal in-process so isEditing is accurate without Redis', async () => {
    const service = await createPresenceService(null);
    await service.join(PAGE_A, viewer('u1'));
    await service.join(PAGE_A, viewer('u2'));
    await service.markEditing(PAGE_A, 'u1', 'socket-1');

    const byId = Object.fromEntries((await service.listViewers(PAGE_A)).map((v) => [v.userId, v.isEditing]));
    expect(byId.u1).toBe(true);
    expect(byId.u2).toBe(false);

    await service.unmarkEditing(PAGE_A, 'u1', 'socket-1');
    expect((await service.listViewers(PAGE_A)).find((v) => v.userId === 'u1')?.isEditing).toBe(false);
    await service.shutdown();
  });

  it('refreshEditing in-process keeps the signal alive without emitting a change', async () => {
    const service = await createPresenceService(null);
    const changes: string[] = [];
    service.onViewersChanged((pageId) => changes.push(pageId));

    await service.join(PAGE_A, viewer('u1'));
    await service.markEditing(PAGE_A, 'u1', 'socket-1');
    const afterMark = changes.length;

    await service.refreshEditing(PAGE_A, 'u1', 'socket-1');
    // refreshEditing must not emit a change event.
    expect(changes.length).toBe(afterMark);
    expect((await service.listViewers(PAGE_A))[0].isEditing).toBe(true);
    await service.shutdown();
  });

  it('emits change events for join / leave so the local handler re-broadcasts', async () => {
    const service = await createPresenceService(null);
    const changes: string[] = [];
    service.onViewersChanged((pageId) => changes.push(pageId));

    await service.join(PAGE_A, viewer('u1'));
    await service.leave(PAGE_A, 'u1');

    expect(changes).toEqual([PAGE_A, PAGE_A]);
    await service.shutdown();
  });

  it('publishPageUpdated emits to local onPageUpdated listeners exactly once (no Redis loopback)', async () => {
    const service = await createPresenceService(null);
    const seen: PageUpdatedPayload[] = [];
    const unsubscribe = service.onPageUpdated((_pageId, payload) => seen.push(payload));
    const payload: PageUpdatedPayload = { pageId: PAGE_A, revisionId: 'rev-1', editorUserId: 'u1', editorDisplayName: 'User One' };

    await service.publishPageUpdated(PAGE_A, payload);
    // Single-instance: no Redis loopback, so exactly one delivery.
    expect(seen).toEqual([payload]);

    // Unsubscribe stops further delivery.
    unsubscribe();
    await service.publishPageUpdated(PAGE_A, payload);
    expect(seen).toHaveLength(1);
    await service.shutdown();
  });

  it('publishCommentChanged emits to local onCommentChanged listeners exactly once (no Redis loopback)', async () => {
    const service = await createPresenceService(null);
    const seen: CommentChangedPayload[] = [];
    const unsubscribe = service.onCommentChanged((_pageId, p) => seen.push(p));
    const payload: CommentChangedPayload = { pageId: PAGE_A, changeType: 'added', commentId: 'comment-1', actorUserId: 'u1' };

    await service.publishCommentChanged(PAGE_A, payload);
    // Single-instance: no Redis loopback, so exactly one delivery.
    expect(seen).toEqual([payload]);

    unsubscribe();
    await service.publishCommentChanged(PAGE_A, payload);
    expect(seen).toHaveLength(1);
    await service.shutdown();
  });
});

/**
 * RFC-0005 — collab → presence wiring + periodic editing-hash
 * refresher. The adapter tracks every live editor connection of *this*
 * process and re-`refreshEditing`s them on an interval so the Redis
 * editing hash field never ages out while the editor is connected;
 * `shutdown()` stops the timer.
 */
describe('createPresenceCollabDeps — editing-hash refresher', () => {
  interface RecordingService extends PresenceService {
    calls: Array<{ method: 'markEditing' | 'refreshEditing' | 'unmarkEditing'; pageId: string; userId: string; socketId: string }>;
  }

  /** A presence-service stand-in that records the editing calls. */
  const makeRecordingService = (): RecordingService => {
    const calls: RecordingService['calls'] = [];
    return {
      calls,
      async join() {},
      async heartbeat() {
        return true;
      },
      async leave() {},
      async listViewers() {
        return [];
      },
      async markEditing(pageId, userId, socketId) {
        calls.push({ method: 'markEditing', pageId, userId, socketId });
      },
      async refreshEditing(pageId, userId, socketId) {
        calls.push({ method: 'refreshEditing', pageId, userId, socketId });
      },
      async unmarkEditing(pageId, userId, socketId) {
        calls.push({ method: 'unmarkEditing', pageId, userId, socketId });
      },
      onViewersChanged() {
        return () => {};
      },
      async shutdown() {},
    };
  };

  // `createPresenceCollabDeps` only ever reads `crowi` through
  // `getPresenceService`, which is short-circuited here by
  // `_setPresenceServiceForTesting`, so a bare object suffices.
  const fakeCrowi = {} as Crowi;

  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
    _setPresenceServiceForTesting(null);
  });

  it('forwards markEditing / unmarkEditing to the presence service with the socketId', async () => {
    const service = makeRecordingService();
    _setPresenceServiceForTesting(service);
    const deps = createPresenceCollabDeps(fakeCrowi);

    await deps.markEditing(PAGE_A, 'u1', 'socket-1');
    await deps.unmarkEditing(PAGE_A, 'u1', 'socket-1');
    deps.shutdown();

    expect(service.calls).toEqual([
      { method: 'markEditing', pageId: PAGE_A, userId: 'u1', socketId: 'socket-1' },
      { method: 'unmarkEditing', pageId: PAGE_A, userId: 'u1', socketId: 'socket-1' },
    ]);
  });

  it('refreshes every live editor connection on each interval tick', async () => {
    const service = makeRecordingService();
    _setPresenceServiceForTesting(service);
    const deps = createPresenceCollabDeps(fakeCrowi);

    await deps.markEditing(PAGE_A, 'u1', 'socket-1');
    await deps.markEditing(PAGE_A, 'u2', 'socket-2');

    // Advance one refresh interval and let the async tick body settle.
    await jest.advanceTimersByTimeAsync(EDITING_REFRESH_MS);

    const refreshes = service.calls.filter((c) => c.method === 'refreshEditing');
    expect(refreshes).toEqual(
      expect.arrayContaining([
        { method: 'refreshEditing', pageId: PAGE_A, userId: 'u1', socketId: 'socket-1' },
        { method: 'refreshEditing', pageId: PAGE_A, userId: 'u2', socketId: 'socket-2' },
      ]),
    );
    expect(refreshes).toHaveLength(2);
    deps.shutdown();
  });

  it('stops refreshing a connection once it is unmarked', async () => {
    const service = makeRecordingService();
    _setPresenceServiceForTesting(service);
    const deps = createPresenceCollabDeps(fakeCrowi);

    await deps.markEditing(PAGE_A, 'u1', 'socket-1');
    await deps.unmarkEditing(PAGE_A, 'u1', 'socket-1');

    await jest.advanceTimersByTimeAsync(EDITING_REFRESH_MS);

    expect(service.calls.filter((c) => c.method === 'refreshEditing')).toHaveLength(0);
    deps.shutdown();
  });

  it('shutdown stops the refresher so no further ticks fire', async () => {
    const service = makeRecordingService();
    _setPresenceServiceForTesting(service);
    const deps = createPresenceCollabDeps(fakeCrowi);

    await deps.markEditing(PAGE_A, 'u1', 'socket-1');
    deps.shutdown();

    await jest.advanceTimersByTimeAsync(EDITING_REFRESH_MS * 3);

    expect(service.calls.filter((c) => c.method === 'refreshEditing')).toHaveLength(0);
  });
});
