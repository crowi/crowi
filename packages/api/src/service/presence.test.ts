import { createPresenceService, type PresenceRedisClient, PRESENCE_UPDATES_CHANNEL, VIEWER_HASH_PREFIX, VIEWER_TTL_MS } from './presence';

/**
 * RFC-0005 Phase 1 — presence service tests.
 *
 * Exercises the Redis-backed implementation against a deterministic
 * in-memory fake (`FakeRedis`) so join / leave / dedup / TTL-sweep /
 * isEditing-join / cross-instance pub/sub all run without a live
 * Redis. The in-process (no-Redis) fallback is also covered so the
 * single-instance dev path doesn't silently regress.
 */

/**
 * Minimal in-memory node-redis v4 stand-in. One backing store is
 * shared by every `duplicate()`-d client so a subscriber sees what the
 * primary publishes — the fixture for the multi-instance test.
 */
class FakeRedis implements PresenceRedisClient {
  isOpen = true;
  private readonly hashes: Map<string, Map<string, string>>;
  private readonly sets: Map<string, Set<string>>;
  private readonly subscribers: Map<string, Array<(message: string) => void>>;

  constructor(shared?: {
    hashes: Map<string, Map<string, string>>;
    sets: Map<string, Set<string>>;
    subscribers: Map<string, Array<(message: string) => void>>;
  }) {
    this.hashes = shared?.hashes ?? new Map();
    this.sets = shared?.sets ?? new Map();
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
    // TTL is exercised at the application layer (lastHeartbeatAt
    // sweep); the fake does not model key expiry.
    return true;
  }

  async sMembers(key: string): Promise<string[]> {
    return [...(this.sets.get(key) ?? [])];
  }

  /** Test helper — seed the editor-cap Set for isEditing-join tests. */
  seedEditorSet(key: string, members: string[]): void {
    this.sets.set(key, new Set(members));
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
    return new FakeRedis({ hashes: this.hashes, sets: this.sets, subscribers: this.subscribers });
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

describe('presence service — Redis-backed (RFC-0005 Phase 1)', () => {
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
    const service = await createPresenceService(new FakeRedis());
    await service.join(PAGE_A, viewer('u1'));
    const firstJoinedAt = (await service.listViewers(PAGE_A))[0].joinedAt;

    await new Promise((r) => setTimeout(r, 5));
    await service.join(PAGE_A, viewer('u1'));
    const secondJoinedAt = (await service.listViewers(PAGE_A))[0].joinedAt;

    expect(secondJoinedAt).toBe(firstJoinedAt);
    await service.shutdown();
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

  it('joins the editor-cap Set so a viewing editor gets isEditing=true', async () => {
    const redis = new FakeRedis();
    // RFC-0003 editor-cap Set member shape is `<userId>:<socketId>`.
    redis.seedEditorSet(`crowi:collab:editors:${PAGE_A}`, ['u1:socket-1', 'u1:socket-2']);
    const service = await createPresenceService(redis);

    await service.join(PAGE_A, viewer('u1'));
    await service.join(PAGE_A, viewer('u2'));

    const viewers = await service.listViewers(PAGE_A);
    const byId = Object.fromEntries(viewers.map((v) => [v.userId, v.isEditing]));
    expect(byId.u1).toBe(true);
    expect(byId.u2).toBe(false);
    await service.shutdown();
  });

  it('markEditing / unmarkEditing publish a viewer-list change for the badge', async () => {
    const redis = new FakeRedis();
    const publishSpy = jest.spyOn(redis, 'publish');
    const service = await createPresenceService(redis);
    const changes: string[] = [];
    service.onViewersChanged((pageId) => changes.push(pageId));

    await service.markEditing(PAGE_A, 'u1');
    await service.unmarkEditing(PAGE_A, 'u1');

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

  it('publishes joins on the documented pub/sub channel name', async () => {
    const redis = new FakeRedis();
    const publishSpy = jest.spyOn(redis, 'publish');
    const service = await createPresenceService(redis);

    await service.join(PAGE_A, viewer('u1'));

    expect(publishSpy).toHaveBeenCalledWith(PRESENCE_UPDATES_CHANNEL, PAGE_A);
    await service.shutdown();
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
    // No Redis → no editor-cap Set → no editing signal.
    expect(viewers.every((v) => v.isEditing === false)).toBe(true);
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
});
