import type Crowi from 'src/crowi';
import { resolveRedisKeyspace } from 'src/util/redis-keyspace';
import {
  _setPresenceServiceForTesting,
  type CommentChangedPayload,
  createPresenceCollabDeps,
  createPresenceService,
  EDITING_REFRESH_MS,
  EDITING_TTL_MS,
  type PageUpdatedPayload,
  type PresenceFeed,
  type PresenceRedisClient,
  type PresenceService,
  VIEWER_TTL_MS,
} from './presence';

/**
 * Smallest fixture `resolveRedisKeyspace` reads from a `Crowi` — an
 * explicit `REDIS_KEY_PREFIX` override (mirrors `util/redis-keyspace.test.ts`'s
 * `fakeCrowi`), so these tests don't depend on `CLIENT_URL` derivation.
 */
function fakeKeyspaceCrowi(instanceSlug: string): Crowi {
  return {
    getBaseUrl: () => null,
    getEnv: () => ({ REDIS_KEY_PREFIX: instanceSlug }) as unknown as NodeJS.ProcessEnv,
  } as unknown as Crowi;
}

/**
 * The instance keyspace every "Redis-backed (RFC-0005)" / "generic feed
 * bus" / "page-updated" / "comment-changed" test below resolves through —
 * `createPresenceService`'s Redis-backed overload now REQUIRES a
 * {@link RedisKeyspace} (feature-redis-key-prefix §1/§2 review round 3:
 * there is no legacy non-scoped fallback left in `service/presence.ts` to
 * omit this in favour of), so every test exercising that path needs an
 * explicit one — this is that shared default. Tests specifically about
 * cross-instance keyspace isolation use their own `keyspaceA`/`keyspaceB`
 * below instead.
 */
const TEST_KEYSPACE = resolveRedisKeyspace(fakeKeyspaceCrowi('test'));

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
    const service = await createPresenceService(new FakeRedis(), TEST_KEYSPACE);
    await service.join(PAGE_A, viewer('u1'));

    const viewers = await service.listViewers(PAGE_A);
    expect(viewers).toHaveLength(1);
    expect(viewers[0].userId).toBe('u1');
    expect(viewers[0].isEditing).toBe(false);
    await service.shutdown();
  });

  it('removes a viewer on leave and re-broadcasts the change', async () => {
    const service = await createPresenceService(new FakeRedis(), TEST_KEYSPACE);
    const changes: string[] = [];
    service.subscribe('viewers', (pageId) => changes.push(pageId));

    await service.join(PAGE_A, viewer('u1'));
    await service.leave(PAGE_A, 'u1');

    expect(await service.listViewers(PAGE_A)).toHaveLength(0);
    // join + leave each publish a viewer-list change.
    expect(changes.filter((p) => p === PAGE_A).length).toBeGreaterThanOrEqual(2);
    await service.shutdown();
  });

  it('dedupes the same user across multiple tabs to a single viewer entry', async () => {
    const service = await createPresenceService(new FakeRedis(), TEST_KEYSPACE);
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
      const service = await createPresenceService(new FakeRedis(), TEST_KEYSPACE);
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
    const service = await createPresenceService(new FakeRedis(), TEST_KEYSPACE);
    await service.join(PAGE_A, viewer('u1'));

    expect(await service.heartbeat(PAGE_A, 'u1')).toBe(true);
    expect(await service.heartbeat(PAGE_A, 'ghost')).toBe(false);
    await service.shutdown();
  });

  it('filters out and sweeps viewers whose last heartbeat is past the TTL', async () => {
    const redis = new FakeRedis();
    const service = await createPresenceService(redis, TEST_KEYSPACE);
    await service.join(PAGE_A, viewer('u1'));

    // Rewrite the stored field with a stale lastHeartbeatAt directly.
    const key = TEST_KEYSPACE.key('presence', 'viewers', PAGE_A);
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
    const service = await createPresenceService(redis, TEST_KEYSPACE);

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
    const service = await createPresenceService(redis, TEST_KEYSPACE);

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
    redis.seedEditingHash(TEST_KEYSPACE.key('presence', 'editing', PAGE_A), {
      'u1:dead-socket': Date.now() - EDITING_TTL_MS - 5_000,
    });
    const service = await createPresenceService(redis, TEST_KEYSPACE);

    await service.join(PAGE_A, viewer('u1'));

    const viewers = await service.listViewers(PAGE_A);
    expect(viewers[0].isEditing).toBe(false);
    // The stale field is swept from the editing hash as a side effect.
    expect(await redis.hGet(TEST_KEYSPACE.key('presence', 'editing', PAGE_A), 'u1:dead-socket')).toBeNull();
    await service.shutdown();
  });

  it('refreshEditing keeps a signal fresh but does NOT publish a viewer-list change', async () => {
    const redis = new FakeRedis();
    const publishSpy = jest.spyOn(redis, 'publish');
    const service = await createPresenceService(redis, TEST_KEYSPACE);
    const viewersEnvelope = JSON.stringify({ feed: 'viewers', pageId: PAGE_A });

    await service.markEditing(PAGE_A, 'u1', 'socket-1');
    const afterMark = publishSpy.mock.calls.filter(([, msg]) => msg === viewersEnvelope).length;

    await service.refreshEditing(PAGE_A, 'u1', 'socket-1');
    await service.refreshEditing(PAGE_A, 'u1', 'socket-1');

    // markEditing publishes once; refreshEditing publishes never.
    expect(afterMark).toBe(1);
    expect(publishSpy.mock.calls.filter(([, msg]) => msg === viewersEnvelope)).toHaveLength(1);
    // The signal is still present after the refreshes.
    await service.join(PAGE_A, viewer('u1'));
    expect((await service.listViewers(PAGE_A))[0].isEditing).toBe(true);
    await service.shutdown();
  });

  it('markEditing / unmarkEditing publish a viewer-list change for the badge', async () => {
    const redis = new FakeRedis();
    const publishSpy = jest.spyOn(redis, 'publish');
    const service = await createPresenceService(redis, TEST_KEYSPACE);
    const changes: string[] = [];
    service.subscribe('viewers', (pageId) => changes.push(pageId));
    const viewersEnvelope = JSON.stringify({ feed: 'viewers', pageId: PAGE_A });

    await service.markEditing(PAGE_A, 'u1', 'socket-1');
    await service.unmarkEditing(PAGE_A, 'u1', 'socket-1');

    // Each call publishes the viewers envelope on the generic feed
    // channel exactly once. (The local handler also re-broadcasts via
    // the pub/sub round-trip, so `changes` is observed more than twice
    // — that redundant local broadcast sends an identical viewer list
    // and is harmless; the publish *count* is the precise contract.)
    expect(publishSpy.mock.calls.filter(([, msg]) => msg === viewersEnvelope)).toHaveLength(2);
    expect(changes.filter((p) => p === PAGE_A).length).toBeGreaterThanOrEqual(2);
    await service.shutdown();
  });

  it('fans a join out to a second instance via the pub/sub channel', async () => {
    // Two services backed by the *same* shared Redis store = two api
    // instances behind a load balancer.
    const sharedRedis = new FakeRedis();
    const instanceA = await createPresenceService(sharedRedis, TEST_KEYSPACE);
    const instanceB = await createPresenceService(sharedRedis, TEST_KEYSPACE);

    const seenByB: string[] = [];
    instanceB.subscribe('viewers', (pageId) => seenByB.push(pageId));

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
    const instanceA = await createPresenceService(sharedRedis, TEST_KEYSPACE);
    const instanceB = await createPresenceService(sharedRedis, TEST_KEYSPACE);

    await instanceA.join(PAGE_A, viewer('u1'));
    await instanceA.markEditing(PAGE_A, 'u1', 'socket-1');

    expect((await instanceB.listViewers(PAGE_A))[0].isEditing).toBe(true);

    await instanceA.shutdown();
    await instanceB.shutdown();
  });

  it('publishes joins as a JSON envelope on the generic feed channel (feature-presence-generic-feed-bus)', async () => {
    const redis = new FakeRedis();
    const publishSpy = jest.spyOn(redis, 'publish');
    const service = await createPresenceService(redis, TEST_KEYSPACE);

    await service.join(PAGE_A, viewer('u1'));

    expect(publishSpy).toHaveBeenCalledWith(TEST_KEYSPACE.key('presence', 'feed'), JSON.stringify({ feed: 'viewers', pageId: PAGE_A }));
    await service.shutdown();
  });
});

/**
 * feature-redis-key-prefix §1/§2 — when a resolved {@link RedisKeyspace} is
 * supplied, every Redis key/channel this service touches is instance-scoped
 * (`crowi:<slug>:presence:...`) instead of the legacy, non-scoped literal.
 * `getPresenceService` (the real production entry point, exercised
 * separately below) always resolves and passes one whenever `crowi.redis`
 * is set; these tests exercise `createPresenceService` directly with an
 * explicit keyspace to pin the exact key/channel shape.
 */
describe('presence service — instance keyspace (feature-redis-key-prefix §1/§2)', () => {
  const keyspaceA = resolveRedisKeyspace(fakeKeyspaceCrowi('krswd-a'));
  const keyspaceB = resolveRedisKeyspace(fakeKeyspaceCrowi('krswd-b'));

  it('scopes the viewer hash key to the instance slug', async () => {
    const redis = new FakeRedis();
    const service = await createPresenceService(redis, keyspaceA);
    await service.join(PAGE_A, viewer('u1'));

    expect(await redis.hGetAll(`crowi:krswd-a:presence:viewers:${PAGE_A}`)).not.toEqual({});
    // The pre-feature (non-instance-scoped) literal is never written —
    // `service/presence.ts` no longer has any code path that could produce
    // it (there is no legacy fallback left to regress into), but this pins
    // the exact legacy shape as a name-collision guard.
    expect(await redis.hGetAll(`crowi:presence:viewers:${PAGE_A}`)).toEqual({});
    await service.shutdown();
  });

  it('scopes the editing hash key to the instance slug', async () => {
    const redis = new FakeRedis();
    const service = await createPresenceService(redis, keyspaceA);
    await service.markEditing(PAGE_A, 'u1', 'socket-1');

    expect(await redis.hGetAll(`crowi:krswd-a:presence:editing:${PAGE_A}`)).not.toEqual({});
    expect(await redis.hGetAll(`crowi:presence:editing:${PAGE_A}`)).toEqual({});
    await service.shutdown();
  });

  it('publishes on the instance-scoped feed channel, not the legacy literal', async () => {
    const redis = new FakeRedis();
    const publishSpy = jest.spyOn(redis, 'publish');
    const service = await createPresenceService(redis, keyspaceA);

    await service.join(PAGE_A, viewer('u1'));

    expect(publishSpy).toHaveBeenCalledWith('crowi:krswd-a:presence:feed', JSON.stringify({ feed: 'viewers', pageId: PAGE_A }));
    expect(publishSpy).not.toHaveBeenCalledWith('crowi:presence:feed', expect.anything());
    await service.shutdown();
  });

  it('two instances with distinct keyspaces sharing the same Redis do not cross-talk on the feed channel', async () => {
    const shared = new FakeRedis();
    const instanceA = await createPresenceService(shared, keyspaceA);
    const instanceB = await createPresenceService(shared, keyspaceB);

    const seenByB: string[] = [];
    instanceB.subscribe('viewers', (pageId) => seenByB.push(pageId));

    await instanceA.join(PAGE_A, viewer('u1'));

    // B never observes A's join — distinct keyspaces subscribe to distinct
    // channels even though both share the same underlying Redis.
    expect(seenByB).toEqual([]);
    expect(await instanceB.listViewers(PAGE_A)).toEqual([]);

    await instanceA.shutdown();
    await instanceB.shutdown();
  });
});

/**
 * feature-presence-generic-feed-bus — the generic bus every feed
 * (viewer-list / page-updated / comment-changed) now rides. AC-1
 * (generic `subscribe`/`publish`) and AC-2 (single Redis subscriber
 * connection + JSON envelope, replacing the pre-consolidation
 * bare-pageId-string subscriber + the page-updated/comment-changed
 * JSON subscriber) live here.
 */
describe('presence service — generic feed bus (feature-presence-generic-feed-bus)', () => {
  it('opens exactly ONE Redis subscriber connection for every feed and disconnects it on shutdown (AC-2)', async () => {
    const primary = new FakeRedis();
    const dups: FakeRedis[] = [];
    const realDuplicate = FakeRedis.prototype.duplicate;
    jest.spyOn(primary, 'duplicate').mockImplementation(function (this: FakeRedis) {
      const d = realDuplicate.call(this) as FakeRedis;
      dups.push(d);
      return d;
    });

    const service = await createPresenceService(primary, TEST_KEYSPACE);
    // Pre-consolidation this opened TWO duplicate() clients (a bare
    // pageId-string subscriber for viewer-list + a JSON subscriber
    // shared by page-updated/comment-changed). Now every feed rides one.
    expect(dups).toHaveLength(1);
    const disconnectSpy = jest.spyOn(dups[0], 'disconnect');

    await service.shutdown();
    expect(disconnectSpy).toHaveBeenCalled();
  });

  it('page-updated and comment-changed publishes both reach listeners over that SAME single subscriber (AC-2)', async () => {
    const primary = new FakeRedis();
    const dups: FakeRedis[] = [];
    const realDuplicate = FakeRedis.prototype.duplicate;
    jest.spyOn(primary, 'duplicate').mockImplementation(function (this: FakeRedis) {
      const d = realDuplicate.call(this) as FakeRedis;
      dups.push(d);
      return d;
    });

    const service = await createPresenceService(primary, TEST_KEYSPACE);
    expect(dups).toHaveLength(1);

    const pageUpdatedSeen: PageUpdatedPayload[] = [];
    const commentChangedSeen: CommentChangedPayload[] = [];
    service.subscribe('page-updated', (_pageId, p) => pageUpdatedSeen.push(p as PageUpdatedPayload));
    service.subscribe('comment-changed', (_pageId, p) => commentChangedSeen.push(p as CommentChangedPayload));

    await service.publishPageUpdated(PAGE_A, { pageId: PAGE_A, revisionId: 'rev-x', editorUserId: 'u1', editorDisplayName: 'User One' });
    await service.publishCommentChanged(PAGE_A, { pageId: PAGE_A, changeType: 'added', commentId: 'comment-x', actorUserId: 'u1' });

    expect(pageUpdatedSeen.length).toBeGreaterThanOrEqual(1);
    expect(commentChangedSeen.length).toBeGreaterThanOrEqual(1);
    // Still exactly one subscriber connection after both feeds fired.
    expect(dups).toHaveLength(1);

    await service.shutdown();
  });

  it('publishes every feed as a `{ feed, pageId, payload }` JSON envelope on the one generic channel (AC-1/AC-2)', async () => {
    const redis = new FakeRedis();
    const publishSpy = jest.spyOn(redis, 'publish');
    const service = await createPresenceService(redis, TEST_KEYSPACE);

    await service.publishPageUpdated(PAGE_A, { pageId: PAGE_A, revisionId: 'rev-1', editorUserId: 'u1', editorDisplayName: 'User One' });
    await service.publishCommentChanged(PAGE_A, { pageId: PAGE_A, changeType: 'added', commentId: 'comment-1', actorUserId: 'u1' });

    // Every publish targets the SAME channel — no more per-feed channels.
    const channels = new Set(publishSpy.mock.calls.map(([ch]) => ch));
    expect(channels).toEqual(new Set([TEST_KEYSPACE.key('presence', 'feed')]));
    const bodies = publishSpy.mock.calls.map(([, msg]) => JSON.parse(msg as string) as { feed: PresenceFeed; pageId: string });
    expect(bodies.map((b) => b.feed).sort()).toEqual(['comment-changed', 'page-updated']);
    await service.shutdown();
  });

  it('the generic subscribe/publish pair delivers exactly what the named onXxx/publishXxx wrappers deliver (AC-1)', async () => {
    const redis = new FakeRedis();
    const service = await createPresenceService(redis, TEST_KEYSPACE);

    const viaGeneric: Array<{ pageId: string; payload: unknown }> = [];
    const unsubscribe = service.subscribe('page-updated', (pageId, payload) => viaGeneric.push({ pageId, payload }));

    const payload: PageUpdatedPayload = { pageId: PAGE_A, revisionId: 'rev-1', editorUserId: 'u1', editorDisplayName: 'User One' };
    // Publish through the GENERIC api directly (not `publishPageUpdated`).
    await service.publish('page-updated', PAGE_A, payload);

    expect(viaGeneric).toContainEqual({ pageId: PAGE_A, payload });
    unsubscribe();
    await service.shutdown();
  });

  it('drops an unparseable / non-envelope message on the feed channel instead of guessing a feed for it', async () => {
    const shared = new FakeRedis();
    const instance = await createPresenceService(shared, TEST_KEYSPACE);
    const viewerChanges: string[] = [];
    const pageUpdated: Array<{ pageId: string; payload: unknown }> = [];
    instance.subscribe('viewers', (pageId) => viewerChanges.push(pageId));
    instance.subscribe('page-updated', (pageId, payload) => pageUpdated.push({ pageId, payload }));

    // The presence feed channel is a brand-new channel name — no
    // pre-consolidation process ever published to it, so there is no
    // rolling-deploy scenario where a real publisher sends a bare
    // pageId (or any other non-envelope payload) here. Both must be
    // dropped rather than misinterpreted as a viewer-list change.
    await shared.publish(TEST_KEYSPACE.key('presence', 'feed'), PAGE_A);
    await shared.publish(TEST_KEYSPACE.key('presence', 'feed'), JSON.stringify({ notAnEnvelope: true }));

    expect(viewerChanges).toEqual([]);
    expect(pageUpdated).toEqual([]);
    await instance.shutdown();
  });

  it('drops an envelope whose `feed` is not a known PresenceFeed instead of using it as an EventEmitter event name', async () => {
    // Regression guard: the generic bus's subscriber dispatches an
    // inbound envelope's `feed` field directly to `emitter.emit(feed,
    // ...)`. An unvalidated feed string naming a Node.js special event
    // (e.g. 'error') would otherwise throw synchronously when no
    // listener is registered for it — a wire-reachable crash. This must
    // be dropped exactly like any other corrupt/unparseable message.
    const shared = new FakeRedis();
    const instance = await createPresenceService(shared, TEST_KEYSPACE);
    const viewerChanges: string[] = [];
    instance.subscribe('viewers', (pageId) => viewerChanges.push(pageId));

    await expect(shared.publish(TEST_KEYSPACE.key('presence', 'feed'), JSON.stringify({ feed: 'error', pageId: PAGE_A }))).resolves.not.toThrow();

    expect(viewerChanges).toEqual([]);
    await instance.shutdown();
  });

  it('the generic subscribe/publish pair also works for the in-process (no-Redis) implementation (AC-1)', async () => {
    const service = await createPresenceService(null);
    const seen: Array<{ pageId: string; payload: unknown }> = [];
    const unsubscribe = service.subscribe('comment-changed', (pageId, payload) => seen.push({ pageId, payload }));

    const payload: CommentChangedPayload = { pageId: PAGE_A, changeType: 'added', commentId: 'comment-1', actorUserId: 'u1' };
    await service.publish('comment-changed', PAGE_A, payload);

    expect(seen).toEqual([{ pageId: PAGE_A, payload }]);
    unsubscribe();
    await service.shutdown();
  });
});

/**
 * feature-live-page-content-sync — read-side soft-refresh fan-out.
 * `publishPageUpdated` now rides the single generic feed channel
 * (feature-presence-generic-feed-bus) as a JSON envelope, delegating to
 * the generic `publish('page-updated', ...)`.
 */
describe('presence service — page-updated fan-out (feature-live-page-content-sync)', () => {
  const payload = (overrides: Partial<PageUpdatedPayload> = {}): PageUpdatedPayload => ({
    pageId: PAGE_A,
    revisionId: 'rev-1',
    editorUserId: 'u1',
    editorDisplayName: 'User One',
    ...overrides,
  });

  it('publishes page-updated as a JSON envelope on the generic feed channel', async () => {
    const redis = new FakeRedis();
    const publishSpy = jest.spyOn(redis, 'publish');
    const service = await createPresenceService(redis, TEST_KEYSPACE);

    const p = payload();
    await service.publishPageUpdated(PAGE_A, p);

    expect(publishSpy).toHaveBeenCalledWith(TEST_KEYSPACE.key('presence', 'feed'), JSON.stringify({ feed: 'page-updated', pageId: PAGE_A, payload: p }));
    await service.shutdown();
  });

  it('fans a page-updated signal out to a second instance via the generic feed channel', async () => {
    const shared = new FakeRedis();
    const instanceA = await createPresenceService(shared, TEST_KEYSPACE);
    const instanceB = await createPresenceService(shared, TEST_KEYSPACE);

    const seenByB: Array<{ pageId: string; payload: PageUpdatedPayload }> = [];
    instanceB.subscribe('page-updated', (pageId, p) => seenByB.push({ pageId, payload: p as PageUpdatedPayload }));

    const p = payload();
    await instanceA.publishPageUpdated(PAGE_A, p);

    // B's single subscriber parsed the envelope and re-emitted it.
    expect(seenByB).toContainEqual({ pageId: PAGE_A, payload: p });

    await instanceA.shutdown();
    await instanceB.shutdown();
  });

  it('double-delivers to the ORIGIN instance (local emit + Redis loopback) — client debounce dedupes', async () => {
    // Documented harmless double-send (spec §"double-send"): the origin
    // gets the frame from its own local emit AND from the Redis loopback
    // to its own subscriber, so a viewer on the origin sees it twice. The
    // client's debounce + createdAt monotonicity guard collapse it.
    // Regression guard: AC-4 requires this to be unchanged post-generic.
    const shared = new FakeRedis();
    const origin = await createPresenceService(shared, TEST_KEYSPACE);
    const seen: PageUpdatedPayload[] = [];
    origin.subscribe('page-updated', (_pageId, p) => seen.push(p as PageUpdatedPayload));

    await origin.publishPageUpdated(PAGE_A, payload());

    expect(seen).toHaveLength(2);
    await origin.shutdown();
  });
});

/**
 * feature-live-page-comment-sync — live comment fan-out.
 * `publishCommentChanged` now rides the same single generic feed
 * channel as every other feed (feature-presence-generic-feed-bus),
 * delegating to the generic `publish('comment-changed', ...)`.
 */
describe('presence service — comment-changed fan-out (feature-live-page-comment-sync)', () => {
  const payload = (overrides: Partial<CommentChangedPayload> = {}): CommentChangedPayload => ({
    pageId: PAGE_A,
    changeType: 'added',
    commentId: 'comment-1',
    actorUserId: 'u1',
    ...overrides,
  });

  it('publishes comment-changed as a JSON envelope on the generic feed channel', async () => {
    const redis = new FakeRedis();
    const publishSpy = jest.spyOn(redis, 'publish');
    const service = await createPresenceService(redis, TEST_KEYSPACE);

    const p = payload();
    await service.publishCommentChanged(PAGE_A, p);

    expect(publishSpy).toHaveBeenCalledWith(TEST_KEYSPACE.key('presence', 'feed'), JSON.stringify({ feed: 'comment-changed', pageId: PAGE_A, payload: p }));
    await service.shutdown();
  });

  it('fans a comment-changed out to a second instance via the generic feed channel', async () => {
    const shared = new FakeRedis();
    const instanceA = await createPresenceService(shared, TEST_KEYSPACE);
    const instanceB = await createPresenceService(shared, TEST_KEYSPACE);

    const seenByB: Array<{ pageId: string; payload: CommentChangedPayload }> = [];
    instanceB.subscribe('comment-changed', (pageId, p) => seenByB.push({ pageId, payload: p as CommentChangedPayload }));

    const p = payload();
    await instanceA.publishCommentChanged(PAGE_A, p);

    expect(seenByB).toContainEqual({ pageId: PAGE_A, payload: p });

    await instanceA.shutdown();
    await instanceB.shutdown();
  });

  it('carries a removed frame with no actorUserId across instances', async () => {
    const shared = new FakeRedis();
    const instanceA = await createPresenceService(shared, TEST_KEYSPACE);
    const instanceB = await createPresenceService(shared, TEST_KEYSPACE);

    const seenByB: CommentChangedPayload[] = [];
    instanceB.subscribe('comment-changed', (_pageId, p) => seenByB.push(p as CommentChangedPayload));

    const removed = payload({ changeType: 'removed', commentId: 'comment-9', actorUserId: undefined });
    await instanceA.publishCommentChanged(PAGE_A, removed);

    expect(seenByB).toHaveLength(1);
    expect(seenByB[0].changeType).toBe('removed');
    expect(seenByB[0].actorUserId).toBeUndefined();

    await instanceA.shutdown();
    await instanceB.shutdown();
  });

  it('double-delivers to the ORIGIN instance (local emit + Redis loopback)', async () => {
    // Regression guard: AC-4 requires this to be unchanged post-generic.
    const shared = new FakeRedis();
    const origin = await createPresenceService(shared, TEST_KEYSPACE);
    const seen: CommentChangedPayload[] = [];
    origin.subscribe('comment-changed', (_pageId, p) => seen.push(p as CommentChangedPayload));

    await origin.publishCommentChanged(PAGE_A, payload());

    // Client-side invalidate → re-fetch is idempotent and the seen-set
    // highlight diff yields no new id the second time, so the double
    // delivery is harmless — but the transport DOES deliver twice.
    expect(seen).toHaveLength(2);
    await origin.shutdown();
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
    service.subscribe('viewers', (pageId) => changes.push(pageId));

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
    service.subscribe('viewers', (pageId) => changes.push(pageId));

    await service.join(PAGE_A, viewer('u1'));
    await service.leave(PAGE_A, 'u1');

    expect(changes).toEqual([PAGE_A, PAGE_A]);
    await service.shutdown();
  });

  it("publishPageUpdated emits to local subscribe('page-updated', ...) listeners exactly once (no Redis loopback)", async () => {
    const service = await createPresenceService(null);
    const seen: PageUpdatedPayload[] = [];
    const unsubscribe = service.subscribe('page-updated', (_pageId, payload) => seen.push(payload as PageUpdatedPayload));
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

  it("publishCommentChanged emits to local subscribe('comment-changed', ...) listeners exactly once (no Redis loopback)", async () => {
    const service = await createPresenceService(null);
    const seen: CommentChangedPayload[] = [];
    const unsubscribe = service.subscribe('comment-changed', (_pageId, p) => seen.push(p as CommentChangedPayload));
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
      async publishPageUpdated() {},
      async publishCommentChanged() {},
      subscribe() {
        return () => {};
      },
      async publish() {},
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
