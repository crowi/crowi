import type Crowi from 'src/crowi';
import { resolveRedisKeyspace } from 'src/util/redis-keyspace';

import { createFederatedHandoffStore, type MinimalRedisClient } from './federated-handoff';

/** Fixture `resolveRedisKeyspace` reads for the "Redis-backed" tests below (mirrors `rate-limit.test.ts` / `editor-cap-counter.test.ts`). */
const TEST_KEYSPACE = resolveRedisKeyspace({
  getBaseUrl: () => null,
  getEnv: () => ({ REDIS_KEY_PREFIX: 'test' }) as unknown as NodeJS.ProcessEnv,
} as unknown as Crowi);

interface FakeRedisState {
  values: Map<string, { value: string; expiresAt: number }>;
}

/**
 * Fake `MinimalRedisClient` that models real Redis TTL/NX/EVAL semantics
 * closely enough to exercise `federated-handoff.ts`'s Redis backend:
 *   - `get`/`set` respect PX-derived expiry.
 *   - `set(..., { NX: true })` only succeeds when the key is absent/expired.
 *   - `eval` interprets EXACTLY the `CONSUME_SCRIPT` shape the store sends
 *     (`GET KEYS[1]` then, if present, `SET KEYS[2] ... NX PX ARGV[1]`) —
 *     not a general Lua interpreter, but faithful to the one script this
 *     module ever runs — checking the record's liveness ONCE, synchronously
 *     (no `await` in between), matching real Redis's single-threaded, whole-
 *     script-atomic `EVAL` execution: nothing (including passive TTL
 *     expiry) can interleave between the liveness check and the exactly-
 *     once mark.
 */
function makeFakeRedis(): { client: MinimalRedisClient; state: FakeRedisState } {
  const state: FakeRedisState = { values: new Map() };

  const rawGet = (key: string): string | null => {
    const entry = state.values.get(key);
    if (!entry) return null;
    if (entry.expiresAt <= Date.now()) {
      state.values.delete(key);
      return null;
    }
    return entry.value;
  };

  const rawSetNx = (key: string, value: string, px: number): boolean => {
    if (rawGet(key) != null) return false;
    state.values.set(key, { value, expiresAt: Date.now() + px });
    return true;
  };

  const client: MinimalRedisClient = {
    async get(key) {
      return rawGet(key);
    },
    async set(key, value, options) {
      if (options.NX) {
        return rawSetNx(key, value, options.PX) ? 'OK' : null;
      }
      state.values.set(key, { value, expiresAt: Date.now() + options.PX });
      return 'OK';
    },
    async eval(_script, options) {
      // Synchronous check-then-mark, exactly like the in-memory backend's
      // own comment explains for the SAME reason: no `await` boundary
      // between the two steps means nothing else can interleave. Sentinel
      // strings mirror CONSUME_SCRIPT exactly (see its doc comment for why
      // they can never collide with a genuine JSON record value).
      const [recordKey, consumedKey] = options.keys;
      const [pxRaw] = options.arguments;
      const record = rawGet(recordKey);
      if (record == null) return 'NOT_FOUND';
      const marked = rawSetNx(consumedKey, '1', Number(pxRaw));
      if (!marked) return 'ALREADY_CONSUMED';
      return record;
    },
  };

  return { client, state };
}

describe('createFederatedHandoffStore', () => {
  describe('Redis-backed', () => {
    test('issue -> find -> consumeVerified round-trips, and a second consumeVerified for the same code reports already_consumed', async () => {
      const { client } = makeFakeRedis();
      const store = createFederatedHandoffStore({ redisClient: client, keyspace: TEST_KEYSPACE });

      const code = await store.issue('user-1', 'jkt-1');
      expect(await store.find(code)).toEqual({ userId: 'user-1', handoffJkt: 'jkt-1' });

      const consumed = await store.consumeVerified(code);
      expect(consumed).toEqual({ ok: true, record: { userId: 'user-1', handoffJkt: 'jkt-1' } });

      // find() still sees the record (it never deletes) — this is what lets
      // the caller distinguish 401 (never existed) from 409 (already
      // consumed by a valid proof) — see the module doc comment.
      expect(await store.find(code)).toEqual({ userId: 'user-1', handoffJkt: 'jkt-1' });
      expect(await store.consumeVerified(code)).toEqual({ ok: false, reason: 'already_consumed' });
    });

    test('find returns null and consumeVerified reports not_found for a code that was never issued', async () => {
      const { client } = makeFakeRedis();
      const store = createFederatedHandoffStore({ redisClient: client, keyspace: TEST_KEYSPACE });

      expect(await store.find('never-issued')).toBeNull();
      expect(await store.consumeVerified('never-issued')).toEqual({ ok: false, reason: 'not_found' });
    });

    test('a record past its TTL is neither found nor consumable, and consumeVerified reports not_found — NOT already_consumed (AC-5)', async () => {
      jest.useFakeTimers();
      try {
        const { client } = makeFakeRedis();
        const store = createFederatedHandoffStore({ redisClient: client, keyspace: TEST_KEYSPACE });
        const code = await store.issue('user-1', 'jkt-1');

        jest.advanceTimersByTime(30_001); // past the 30s HANDOFF_TTL_MS
        expect(await store.find(code)).toBeNull();
        expect(await store.consumeVerified(code)).toEqual({ ok: false, reason: 'not_found' });
      } finally {
        jest.useRealTimers();
      }
    });

    test("a code that is LIVE at find() but crosses its TTL before consumeVerified() reports not_found, not already_consumed (AC-5 — the exact race a caller's proof-verification delay creates)", async () => {
      jest.useFakeTimers();
      try {
        const { client } = makeFakeRedis();
        const store = createFederatedHandoffStore({ redisClient: client, keyspace: TEST_KEYSPACE });
        const code = await store.issue('user-1', 'jkt-1');

        // Models the real handler: find() succeeds well within the TTL...
        expect(await store.find(code)).toEqual({ userId: 'user-1', handoffJkt: 'jkt-1' });
        // ...then time advances past the TTL boundary before the atomic
        // consume runs (e.g. slow sender-proof verification) — nobody else
        // ever touched this code, so this must NOT be reported the same as
        // a genuine racing double-consume.
        jest.advanceTimersByTime(30_001);
        expect(await store.consumeVerified(code)).toEqual({ ok: false, reason: 'not_found' });
      } finally {
        jest.useRealTimers();
      }
    });

    test('consumeVerified is a single atomic EVAL call, not a separate GET + SET NX (closes the expiry race window)', async () => {
      const evalCalls: unknown[] = [];
      const getCalls: unknown[] = [];
      const { client } = makeFakeRedis();
      const spiedClient: MinimalRedisClient = {
        ...client,
        async get(key) {
          getCalls.push(key);
          return client.get(key);
        },
        async eval(script, options) {
          evalCalls.push(options);
          return client.eval(script, options);
        },
      };
      const store = createFederatedHandoffStore({ redisClient: spiedClient, keyspace: TEST_KEYSPACE });
      const code = await store.issue('user-1', 'jkt-1');

      await store.consumeVerified(code);

      expect(evalCalls).toHaveLength(1);
      // consumeVerified() itself must never call `get` directly — only
      // `find()` does. A regression back to a separate GET + SET NX would
      // show up here as an extra `get` call from inside `consumeVerified`.
      expect(getCalls).toHaveLength(0);
    });

    test('concurrent consumeVerified calls for the SAME code resolve exactly one winner (no double-consume)', async () => {
      const { client } = makeFakeRedis();
      const store = createFederatedHandoffStore({ redisClient: client, keyspace: TEST_KEYSPACE });
      const code = await store.issue('user-1', 'jkt-1');

      const [first, second] = await Promise.all([store.consumeVerified(code), store.consumeVerified(code)]);
      const winners = [first, second].filter((r) => r.ok);
      const losers = [first, second].filter((r) => !r.ok);
      expect(winners).toHaveLength(1);
      expect(losers).toEqual([{ ok: false, reason: 'already_consumed' }]);
    });

    test('a storage-layer error from get() propagates (never swallowed to a false 401)', async () => {
      const { client } = makeFakeRedis();
      const boomClient: MinimalRedisClient = { ...client, get: async () => Promise.reject(new Error('redis connection reset')) };
      const store = createFederatedHandoffStore({ redisClient: boomClient, keyspace: TEST_KEYSPACE });

      await expect(store.find('some-code')).rejects.toThrow('redis connection reset');
    });

    test('a storage-layer error from eval() propagates (never swallowed to a false 401/409)', async () => {
      const { client } = makeFakeRedis();
      const boomClient: MinimalRedisClient = { ...client, eval: async () => Promise.reject(new Error('redis EVAL failed')) };
      const store = createFederatedHandoffStore({ redisClient: boomClient, keyspace: TEST_KEYSPACE });

      await expect(store.consumeVerified('some-code')).rejects.toThrow('redis EVAL failed');
    });

    test('throws at construction (not at issue()/find() time) when redisClient is supplied without a keyspace', () => {
      const { client } = makeFakeRedis();
      expect(() => createFederatedHandoffStore({ redisClient: client })).toThrow(/keyspace.*required/i);
    });
  });

  describe('in-memory fallback (no Redis)', () => {
    test('issue -> find -> consumeVerified round-trips, and a second consumeVerified for the same code reports already_consumed', async () => {
      const store = createFederatedHandoffStore();

      const code = await store.issue('user-1', 'jkt-1');
      expect(await store.find(code)).toEqual({ userId: 'user-1', handoffJkt: 'jkt-1' });
      expect(await store.consumeVerified(code)).toEqual({ ok: true, record: { userId: 'user-1', handoffJkt: 'jkt-1' } });
      expect(await store.find(code)).toEqual({ userId: 'user-1', handoffJkt: 'jkt-1' });
      expect(await store.consumeVerified(code)).toEqual({ ok: false, reason: 'already_consumed' });
    });

    test('a record past its TTL is neither found nor consumable, and consumeVerified reports not_found — NOT already_consumed (AC-5)', async () => {
      jest.useFakeTimers();
      try {
        const store = createFederatedHandoffStore();
        const code = await store.issue('user-1', 'jkt-1');

        jest.advanceTimersByTime(30_001);
        expect(await store.find(code)).toBeNull();
        expect(await store.consumeVerified(code)).toEqual({ ok: false, reason: 'not_found' });
      } finally {
        jest.useRealTimers();
      }
    });

    test('a code that is LIVE at find() but crosses its TTL before consumeVerified() reports not_found, not already_consumed (AC-5)', async () => {
      jest.useFakeTimers();
      try {
        const store = createFederatedHandoffStore();
        const code = await store.issue('user-1', 'jkt-1');

        expect(await store.find(code)).toEqual({ userId: 'user-1', handoffJkt: 'jkt-1' });
        jest.advanceTimersByTime(30_001);
        expect(await store.consumeVerified(code)).toEqual({ ok: false, reason: 'not_found' });
      } finally {
        jest.useRealTimers();
      }
    });

    test('concurrent consumeVerified calls for the SAME code resolve exactly one winner (no double-consume)', async () => {
      const store = createFederatedHandoffStore();
      const code = await store.issue('user-1', 'jkt-1');

      const [first, second] = await Promise.all([store.consumeVerified(code), store.consumeVerified(code)]);
      const winners = [first, second].filter((r) => r.ok);
      const losers = [first, second].filter((r) => !r.ok);
      expect(winners).toHaveLength(1);
      expect(losers).toEqual([{ ok: false, reason: 'already_consumed' }]);
    });
  });
});
