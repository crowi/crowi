import { createEditorCapCounter, type MinimalRedisClient } from './editor-cap-counter';

/**
 * Unit tests for RFC-0003 Phase 6 editor cap counter.
 *
 * Strategy: drive a fake `MinimalRedisClient` (matching the subset of
 * node-redis v4 we depend on) and assert the public surface. Mirrors
 * the `service/page-event-pubsub.test.ts` posture — the Redis client
 * lifecycle itself is integration-tested elsewhere; here we cover
 * the cap counter's behaviour (cap rollover / Set idempotency / TTL
 * re-arm / fail-open paths).
 */

interface FakeRedisState {
  sets: Map<string, Set<string>>;
  expires: Map<string, number>;
  isOpen: boolean;
}

function makeFakeRedis(): { client: MinimalRedisClient; state: FakeRedisState } {
  const state: FakeRedisState = {
    sets: new Map(),
    expires: new Map(),
    isOpen: true,
  };
  const client: MinimalRedisClient = {
    get isOpen() {
      return state.isOpen;
    },
    async connect() {
      state.isOpen = true;
    },
    async disconnect() {
      state.isOpen = false;
    },
    async sCard(key) {
      return state.sets.get(key)?.size ?? 0;
    },
    async sAdd(key, member) {
      const set = state.sets.get(key) ?? new Set<string>();
      const before = set.size;
      set.add(member);
      state.sets.set(key, set);
      return set.size - before;
    },
    async sRem(key, member) {
      const set = state.sets.get(key);
      if (!set) return 0;
      const had = set.delete(member);
      return had ? 1 : 0;
    },
    async expire(key, seconds) {
      state.expires.set(key, seconds);
      return 1;
    },
  };
  return { client, state };
}

describe('createEditorCapCounter', () => {
  let warnSpy: jest.SpyInstance;

  beforeEach(() => {
    warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => {
    warnSpy.mockRestore();
  });

  describe('no Redis configured (fail-open)', () => {
    test('peek always returns count=0 and the configured cap', async () => {
      const counter = await createEditorCapCounter({ redisOpts: null, maxEditorsPerPage: 7 });
      await expect(counter.peek('any-page')).resolves.toEqual({ count: 0, cap: 7 });
    });

    test('tryAcquire always succeeds (cap effectively disabled)', async () => {
      const counter = await createEditorCapCounter({ redisOpts: null });
      const result = await counter.tryAcquire('p1', 'u1', 's1');
      expect(result.acquired).toBe(true);
    });

    test('release is a silent no-op', async () => {
      const counter = await createEditorCapCounter({ redisOpts: null });
      await expect(counter.release('p1', 'u1', 's1')).resolves.toBeUndefined();
    });

    test('disconnect is a silent no-op even when no client was ever opened', async () => {
      const counter = await createEditorCapCounter({ redisOpts: null });
      await expect(counter.disconnect()).resolves.toBeUndefined();
    });

    test('maxEditorsPerPage defaults to 20 when not provided', async () => {
      const counter = await createEditorCapCounter({ redisOpts: null });
      expect(counter.maxEditorsPerPage).toBe(20);
    });
  });

  describe('Redis-backed (driven by fake client)', () => {
    test('tryAcquire fills the set up to the cap, then rejects extra acquirers', async () => {
      const { client } = makeFakeRedis();
      const counter = await createEditorCapCounter({ __clientForTest: client, maxEditorsPerPage: 3 });

      const r1 = await counter.tryAcquire('p1', 'u1', 's1');
      const r2 = await counter.tryAcquire('p1', 'u2', 's2');
      const r3 = await counter.tryAcquire('p1', 'u3', 's3');
      const r4 = await counter.tryAcquire('p1', 'u4', 's4');

      expect(r1.acquired).toBe(true);
      expect(r1.count).toBe(1);
      expect(r2.acquired).toBe(true);
      expect(r2.count).toBe(2);
      expect(r3.acquired).toBe(true);
      expect(r3.count).toBe(3);
      expect(r4.acquired).toBe(false);
      expect(r4.count).toBe(3);
      expect(r4.cap).toBe(3);
    });

    test('release frees a slot — subsequent tryAcquire succeeds again', async () => {
      const { client } = makeFakeRedis();
      const counter = await createEditorCapCounter({ __clientForTest: client, maxEditorsPerPage: 2 });

      await counter.tryAcquire('p1', 'u1', 's1');
      await counter.tryAcquire('p1', 'u2', 's2');
      // p1 is full; 3rd is rejected.
      expect((await counter.tryAcquire('p1', 'u3', 's3')).acquired).toBe(false);
      // free one slot
      await counter.release('p1', 'u2', 's2');
      // now the 3rd should fit
      const retry = await counter.tryAcquire('p1', 'u3', 's3');
      expect(retry.acquired).toBe(true);
      expect(retry.count).toBe(2);
    });

    test('SADD with the same `<userId>:<socketId>` is idempotent (Set semantics)', async () => {
      const { client, state } = makeFakeRedis();
      const counter = await createEditorCapCounter({ __clientForTest: client, maxEditorsPerPage: 5 });

      const first = await counter.tryAcquire('p1', 'u1', 's1');
      const second = await counter.tryAcquire('p1', 'u1', 's1');
      expect(first.acquired).toBe(true);
      expect(second.acquired).toBe(true);
      // count must stay at 1 across duplicate acquires
      expect(state.sets.get('crowi:collab:editors:p1')?.size).toBe(1);
    });

    test('peek returns SCARD without mutating the set', async () => {
      const { client, state } = makeFakeRedis();
      const counter = await createEditorCapCounter({ __clientForTest: client, maxEditorsPerPage: 4 });
      await counter.tryAcquire('p1', 'u1', 's1');
      await counter.tryAcquire('p1', 'u2', 's2');

      const observed = await counter.peek('p1');
      expect(observed).toEqual({ count: 2, cap: 4 });
      expect(state.sets.get('crowi:collab:editors:p1')?.size).toBe(2);
    });

    test('TTL is (re-)applied on each successful SADD (sliding window)', async () => {
      const { client, state } = makeFakeRedis();
      const counter = await createEditorCapCounter({ __clientForTest: client, maxEditorsPerPage: 5 });

      await counter.tryAcquire('p1', 'u1', 's1');
      const ttlAfterFirst = state.expires.get('crowi:collab:editors:p1');
      expect(ttlAfterFirst).toBe(86400);

      // mutate the fake to detect the second EXPIRE
      state.expires.set('crowi:collab:editors:p1', 1);
      await counter.tryAcquire('p1', 'u2', 's2');
      expect(state.expires.get('crowi:collab:editors:p1')).toBe(86400);
    });

    test('keys are scoped per page id (no cross-page leakage)', async () => {
      const { client } = makeFakeRedis();
      const counter = await createEditorCapCounter({ __clientForTest: client, maxEditorsPerPage: 1 });

      const a = await counter.tryAcquire('pageA', 'u1', 's1');
      const b = await counter.tryAcquire('pageB', 'u1', 's1');
      expect(a.acquired).toBe(true);
      expect(b.acquired).toBe(true);
    });
  });
});
