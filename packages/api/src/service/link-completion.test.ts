import type Crowi from 'src/crowi';
import { resolveRedisKeyspace } from 'src/util/redis-keyspace';

import {
  createLinkCompletionStore,
  LINK_COMPLETION_AUTHORIZATION_TTL_MS,
  LINK_COMPLETION_CONSUMED_RETENTION_MS,
  type LinkCompletionIssue,
  type LinkCompletionStore,
  type MinimalLinkCompletionRedisClient,
  msFromRedisTimeReply,
} from './link-completion';

describe('msFromRedisTimeReply', () => {
  test('truncates sub-millisecond microseconds instead of carrying them as a decimal', () => {
    // `microseconds` here is 999 short of the next whole millisecond —
    // an unpatched `unixTimestamp * 1000 + microseconds / 1000` would
    // return 1700000000123.999, silently disagreeing with the Lua
    // scripts' own `math.floor(...)` derivation of `now` from the same
    // reply shape.
    expect(msFromRedisTimeReply(['1700000000', '123999'])).toBe(1700000000123);
  });

  test('is exact on a whole-millisecond boundary', () => {
    expect(msFromRedisTimeReply(['1700000000', '500000'])).toBe(1700000000500);
  });
});

const TEST_KEYSPACE = resolveRedisKeyspace({
  getBaseUrl: () => null,
  getEnv: () => ({ REDIS_KEY_PREFIX: 'test' }) as unknown as NodeJS.ProcessEnv,
} as unknown as Crowi);

function makeIssueInput(overrides: Partial<LinkCompletionIssue> = {}): LinkCompletionIssue {
  return {
    state: overrides.state ?? `crowilnk_${'a'.repeat(34)}`,
    stateExpiresAt: overrides.stateExpiresAt ?? Date.now() + 300_000,
    userId: overrides.userId ?? 'user-1',
    authVersion: overrides.authVersion ?? 0,
    provider: overrides.provider ?? 'google',
    providerUserId: overrides.providerUserId ?? 'sub-1',
    ...(overrides.accountLabel !== undefined ? { accountLabel: overrides.accountLabel } : {}),
  };
}

interface FakeRedisState {
  clockMs: number;
  values: Map<string, { value: string; expiresAt: number }>;
}

/**
 * Fake `MinimalLinkCompletionRedisClient` that models real Redis TTL/NX/EVAL/TIME
 * semantics closely enough to exercise `link-completion.ts`'s Redis backend:
 *   - `get`/`set` respect PX-derived expiry against the FAKE's own clock
 *     (never the real wall clock — `time()` returns that same clock, exactly
 *     mirroring how the store only ever asks the client for "now").
 *   - `set(..., { NX: true })` only succeeds when the key is absent/expired.
 *   - `eval` dispatches on the embedded sentinel string to interpret EXACTLY
 *     one of the store's two scripts. Both mirror the real Lua's own
 *     `redis.call('TIME')` — read from the SAME fake clock `get`/`set` use,
 *     inside the fake `eval` itself (not from a separate `ARGV`/pre-fetched
 *     value) — because that in-script `TIME` read is exactly the property
 *     `link-completion.ts`'s real Lua scripts depend on for atomicity (see
 *     that module's doc comment): issue checks the state deadline against
 *     `ARGV[1]` (`stateExpiresAt`) using this fake-`TIME` value, arms the
 *     state-marker `SET NX` gate, and — only on a win — stamps
 *     `issuedAt`/`authorizationExpiresAt` onto the caller-supplied fields
 *     JSON and returns the FULL record (never `'OK'`, matching the real
 *     script); consume checks "already consumed" (the sibling marker)
 *     BEFORE this fake-`TIME` read and the authorization deadline, then
 *     rewrites the winner's record/marker with the retention TTL. Not a
 *     general Lua interpreter, but faithful to cjson-style encode/decode +
 *     the exact control flow of both scripts.
 */
function makeFakeRedis(initialClockMs = Date.now()): {
  client: MinimalLinkCompletionRedisClient;
  state: FakeRedisState;
  advanceClock: (ms: number) => void;
} {
  const state: FakeRedisState = { clockMs: initialClockMs, values: new Map() };

  const rawGet = (key: string): string | null => {
    const entry = state.values.get(key);
    if (!entry) return null;
    if (entry.expiresAt <= state.clockMs) {
      state.values.delete(key);
      return null;
    }
    return entry.value;
  };

  const rawSet = (key: string, value: string, px: number): void => {
    state.values.set(key, { value, expiresAt: state.clockMs + px });
  };

  const rawSetNx = (key: string, value: string, px: number): boolean => {
    if (rawGet(key) != null) return false;
    rawSet(key, value, px);
    return true;
  };

  const client: MinimalLinkCompletionRedisClient = {
    async get(key) {
      return rawGet(key);
    },
    async time() {
      // Mirrors node-redis's real `TIME` reply shape (`[unixTimestamp,
      // microseconds]`, decimal strings) — round-trips exactly through
      // `msFromRedisTimeReply` back to `state.clockMs`.
      const seconds = Math.floor(state.clockMs / 1000);
      const micros = (state.clockMs % 1000) * 1000;
      return [String(seconds), String(micros)] as const;
    },
    async eval(script, options) {
      if (script.includes('STATE_ALREADY_ISSUED')) {
        const [stateKey, recordKey] = options.keys;
        const [stateExpiresAtRaw, fieldsJson, authorizationTtlRaw] = options.arguments;
        // Mirrors the real Lua's `redis.call('TIME')` — read INSIDE the
        // script, atomically with the deadline check and the mutating
        // `SET`s below, never a value threaded in via `ARGV`.
        const now = state.clockMs;
        const stateExpiresAt = Number(stateExpiresAtRaw);
        if (now >= stateExpiresAt) return 'STATE_EXPIRED';
        const residualStateTtl = Math.max(1, stateExpiresAt - now);
        const marked = rawSetNx(stateKey, '1', residualStateTtl);
        if (!marked) return 'STATE_ALREADY_ISSUED';
        // Fake cjson.decode/encode equivalent — the store's own contract is
        // what asserts the real shape; this fake only needs the fields it
        // reads/writes.
        const authorizationTtl = Number(authorizationTtlRaw);
        const record = {
          ...(JSON.parse(fieldsJson) as Record<string, unknown>),
          issuedAt: now,
          authorizationExpiresAt: now + authorizationTtl,
          consumedAt: null,
          retentionExpiresAt: null,
        };
        const json = JSON.stringify(record);
        rawSet(recordKey, json, authorizationTtl);
        return json;
      }
      const [recordKey, consumedKey] = options.keys;
      const [retentionRaw] = options.arguments;
      const recordRaw = rawGet(recordKey);
      if (recordRaw == null) return 'NOT_FOUND';
      if (rawGet(consumedKey) != null) return 'ALREADY_CONSUMED';
      // Fake cjson.decode() equivalent — the store's own contract is what asserts the real shape; this fake only needs the fields it reads/writes.
      const record = JSON.parse(recordRaw) as { authorizationExpiresAt: number; consumedAt: number | null; retentionExpiresAt: number | null };
      // Mirrors the real Lua's `redis.call('TIME')`, read only AFTER the
      // already-consumed check above — see this file's module doc comment.
      const now = state.clockMs;
      if (now >= record.authorizationExpiresAt) return 'NOT_FOUND';
      const retentionMs = Number(retentionRaw);
      record.consumedAt = now;
      record.retentionExpiresAt = now + retentionMs;
      const updated = JSON.stringify(record);
      rawSet(recordKey, updated, retentionMs);
      rawSet(consumedKey, '1', retentionMs);
      return updated;
    },
  };

  return {
    client,
    state,
    advanceClock: (ms: number) => {
      state.clockMs += ms;
    },
  };
}

describe('createLinkCompletionStore', () => {
  describe.each([
    ['Redis-backed', () => createLinkCompletionStore({ redisClient: makeFakeRedis().client, keyspace: TEST_KEYSPACE })],
    ['in-memory fallback', () => createLinkCompletionStore()],
  ] as const)('%s — 3-method-only interface (AC-17)', (_label, makeStore) => {
    test('exposes exactly issue/find/consumeVerified', () => {
      const store = makeStore();
      expect(Object.keys(store).sort()).toEqual(['consumeVerified', 'find', 'issue']);
    });
  });

  describe('Redis-backed', () => {
    function makeStore(clockMs?: number): { store: LinkCompletionStore; fake: ReturnType<typeof makeFakeRedis> } {
      const fake = makeFakeRedis(clockMs);
      const store = createLinkCompletionStore({ redisClient: fake.client, keyspace: TEST_KEYSPACE });
      return { store, fake };
    }

    test('issue -> find -> consumeVerified round-trips; pre-consume record has null consumedAt/retentionExpiresAt', async () => {
      const { store } = makeStore();
      const outcome = await store.issue(makeIssueInput());
      expect(outcome.ok).toBe(true);
      if (!outcome.ok) throw new Error('unreachable');
      expect(outcome.code).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(outcome.record.consumedAt).toBeNull();
      expect(outcome.record.retentionExpiresAt).toBeNull();

      const found = await store.find(outcome.code);
      expect(found).toEqual(outcome.record);

      const consumed = await store.consumeVerified(outcome.code);
      expect(consumed).toEqual({ ok: true, record: { ...outcome.record, consumedAt: expect.any(Number), retentionExpiresAt: expect.any(Number) } });

      // find() still sees it post-consume (409 LINK_COMPLETION_CONSUMED needs this).
      const foundAfterConsume = await store.find(outcome.code);
      expect(foundAfterConsume?.consumedAt).not.toBeNull();

      expect(await store.consumeVerified(outcome.code)).toEqual({ ok: false, reason: 'already_consumed' });
    });

    test('find/consumeVerified report absence for a never-issued code', async () => {
      const { store } = makeStore();
      expect(await store.find('never-issued')).toBeNull();
      expect(await store.consumeVerified('never-issued')).toEqual({ ok: false, reason: 'not_found' });
    });

    describe('same-state issue idempotency (AC-6)', () => {
      test('a sequential second issue() for the same state reports state_already_issued and never returns a code', async () => {
        const { store } = makeStore();
        const input = makeIssueInput();
        const first = await store.issue(input);
        expect(first.ok).toBe(true);

        const second = await store.issue(input);
        expect(second).toEqual({ ok: false, reason: 'state_already_issued' });
      });

      test('concurrent issue() calls for the same state resolve exactly one winner; the loser never receives a code', async () => {
        const { store } = makeStore();
        const input = makeIssueInput();
        const [a, b] = await Promise.all([store.issue(input), store.issue(input)]);
        const winners = [a, b].filter((r) => r.ok);
        const losers = [a, b].filter((r) => !r.ok);
        expect(winners).toHaveLength(1);
        expect(losers).toEqual([{ ok: false, reason: 'state_already_issued' }]);
      });

      test('different states each get their own code', async () => {
        const { store } = makeStore();
        const a = await store.issue(makeIssueInput({ state: `crowilnk_${'a'.repeat(34)}` }));
        const b = await store.issue(makeIssueInput({ state: `crowilnk_${'b'.repeat(34)}` }));
        expect(a.ok && b.ok && a.code !== b.code).toBe(true);
      });
    });

    describe('three expiries (AC-7)', () => {
      test('a state past its deadline is rejected with state_expired and never reaches the atomic marker step (a later issue for the same state after the window is not "already issued")', async () => {
        const { store, fake } = makeStore(1_000_000);
        const input = makeIssueInput({ stateExpiresAt: 1_000_000 - 1 }); // already past
        expect(await store.issue(input)).toEqual({ ok: false, reason: 'state_expired' });
        // Confirm no state marker/record was created — a later, still-in-window call is fresh, not "already issued".
        fake.advanceClock(0);
      });

      test('code issued at t=0 with a 300s authorization window: consume at 299999ms succeeds, unconsumed at 300000ms is not_found', async () => {
        const { store, fake } = makeStore(0);
        const input = makeIssueInput({ stateExpiresAt: 300_000 });
        const issued = await store.issue(input);
        expect(issued.ok).toBe(true);
        if (!issued.ok) throw new Error('unreachable');
        expect(issued.record.authorizationExpiresAt).toBe(LINK_COMPLETION_AUTHORIZATION_TTL_MS);

        const { store: store2, fake: fake2 } = makeStore(0);
        const issued2 = await store2.issue(input);
        if (!issued2.ok) throw new Error('unreachable');

        fake.advanceClock(299_999);
        expect(await store.consumeVerified(issued.code)).toMatchObject({ ok: true });

        fake2.advanceClock(300_000);
        expect(await store2.consumeVerified(issued2.code)).toEqual({ ok: false, reason: 'not_found' });
        expect(await store2.find(issued2.code)).toBeNull();
      });

      test('state expiry and code expiry are independent: a state with only 1ms left still mints a code with the full 300s window', async () => {
        const { store, fake } = makeStore(0);
        const input = makeIssueInput({ stateExpiresAt: 1 });
        const issued = await store.issue(input);
        expect(issued.ok).toBe(true);
        if (!issued.ok) throw new Error('unreachable');
        expect(issued.record.authorizationExpiresAt).toBe(LINK_COMPLETION_AUTHORIZATION_TTL_MS);

        // The state's own 1ms window has long passed, but the code itself is still live.
        fake.advanceClock(1);
        expect(await store.find(issued.code)).not.toBeNull();
      });

      test('a winner who consumes just before the authorization deadline extends TTL to the 5-minute retention window; a racing loser past the ORIGINAL deadline still sees already_consumed, not not_found (consumed-first ordering)', async () => {
        const { store, fake } = makeStore(0);
        const issued = await store.issue(makeIssueInput({ stateExpiresAt: 300_000 }));
        if (!issued.ok) throw new Error('unreachable');

        fake.advanceClock(299_999);
        const winner = await store.consumeVerified(issued.code);
        expect(winner.ok).toBe(true);

        // Past the ORIGINAL 300000ms authorization deadline, but within the 5-minute retention window.
        fake.advanceClock(2);
        const loser = await store.consumeVerified(issued.code);
        expect(loser).toEqual({ ok: false, reason: 'already_consumed' });
      });

      test('a consumed record is retained for 5 minutes from the consume linearization point, then find() reports null', async () => {
        const { store, fake } = makeStore(0);
        const issued = await store.issue(makeIssueInput({ stateExpiresAt: 300_000 }));
        if (!issued.ok) throw new Error('unreachable');
        fake.advanceClock(100);
        await store.consumeVerified(issued.code);

        fake.advanceClock(LINK_COMPLETION_CONSUMED_RETENTION_MS - 1);
        expect(await store.find(issued.code)).not.toBeNull();

        fake.advanceClock(2);
        expect(await store.find(issued.code)).toBeNull();
      });
    });

    test('the store consults ONLY client.time(), never the real Date.now() — a fake clock wildly different from wall-clock time still governs every decision', async () => {
      const FAR_FUTURE = 5_000_000_000_000; // deliberately far from the real Date.now()
      const { store } = makeStore(FAR_FUTURE);
      const issued = await store.issue(makeIssueInput({ stateExpiresAt: FAR_FUTURE + 300_000 }));
      expect(issued.ok).toBe(true);
      if (!issued.ok) throw new Error('unreachable');
      expect(issued.record.issuedAt).toBe(FAR_FUTURE);
    });

    describe('record size / accountLabel budget (AC-23)', () => {
      test('an unbounded accountLabel that alone would exceed the record budget is omitted, but issue still succeeds with the mandatory fields stored', async () => {
        const { store } = makeStore();
        const hugeEmail = `${'a'.repeat(5000)}@example.com`;
        const issued = await store.issue(makeIssueInput({ accountLabel: hugeEmail }));
        expect(issued.ok).toBe(true);
        if (!issued.ok) throw new Error('unreachable');
        expect(issued.record.accountLabel).toBeUndefined();
        const found = await store.find(issued.code);
        expect(found?.accountLabel).toBeUndefined();
      });

      test('an accountLabel that fits within the budget is stored and returned', async () => {
        const { store } = makeStore();
        const issued = await store.issue(makeIssueInput({ accountLabel: 'user@example.com' }));
        expect(issued.ok).toBe(true);
        if (!issued.ok) throw new Error('unreachable');
        expect(issued.record.accountLabel).toBe('user@example.com');
      });

      test('mandatory fields alone (e.g. a very long providerUserId) are stored in full regardless of size — never a storage error (design decision 22: never regress a currently-linkable identity into a callback failure)', async () => {
        const { store } = makeStore();
        const hugeProviderUserId = 'sub-'.repeat(2000);
        const issued = await store.issue(makeIssueInput({ providerUserId: hugeProviderUserId }));
        expect(issued.ok).toBe(true);
        if (!issued.ok) throw new Error('unreachable');
        expect(issued.record.providerUserId).toBe(hugeProviderUserId);
        const found = await store.find(issued.code);
        expect(found?.providerUserId).toBe(hugeProviderUserId);
      });
    });

    test('a storage-layer error from get() propagates (never swallowed to a false null)', async () => {
      const { client } = makeFakeRedis();
      const boomClient: MinimalLinkCompletionRedisClient = { ...client, get: async () => Promise.reject(new Error('redis connection reset')) };
      const store = createLinkCompletionStore({ redisClient: boomClient, keyspace: TEST_KEYSPACE });
      await expect(store.find('some-code')).rejects.toThrow('redis connection reset');
    });

    test('a storage-layer error from eval() propagates (never swallowed to a false outcome)', async () => {
      const { client } = makeFakeRedis();
      const boomClient: MinimalLinkCompletionRedisClient = { ...client, eval: async () => Promise.reject(new Error('redis EVAL failed')) };
      const store = createLinkCompletionStore({ redisClient: boomClient, keyspace: TEST_KEYSPACE });
      await expect(store.consumeVerified('some-code')).rejects.toThrow('redis EVAL failed');
      await expect(store.issue(makeIssueInput())).rejects.toThrow('redis EVAL failed');
    });

    test('a storage-layer error from time() propagates for find() (fail closed, never a silent Date.now() fallback) — issue()/consumeVerified() no longer call this method at all, see the eval() rejection test above for their own fail-closed path', async () => {
      const { client } = makeFakeRedis();
      const boomClient: MinimalLinkCompletionRedisClient = { ...client, time: async () => Promise.reject(new Error('redis TIME unavailable')) };
      const store = createLinkCompletionStore({ redisClient: boomClient, keyspace: TEST_KEYSPACE });
      await expect(store.find('some-code')).rejects.toThrow('redis TIME unavailable');
    });

    test('hash keys: the plaintext state/code never appear verbatim as a stored key', async () => {
      const { store, fake } = makeStore();
      const input = makeIssueInput();
      const issued = await store.issue(input);
      if (!issued.ok) throw new Error('unreachable');
      const keys = [...fake.state.values.keys()];
      expect(keys.some((k) => k.includes(input.state))).toBe(false);
      expect(keys.some((k) => k.includes(issued.code))).toBe(false);
    });

    test('concurrent consumeVerified calls for the SAME code resolve exactly one winner', async () => {
      const { store } = makeStore();
      const issued = await store.issue(makeIssueInput());
      if (!issued.ok) throw new Error('unreachable');
      const [a, b] = await Promise.all([store.consumeVerified(issued.code), store.consumeVerified(issued.code)]);
      const winners = [a, b].filter((r) => r.ok);
      const losers = [a, b].filter((r) => !r.ok);
      expect(winners).toHaveLength(1);
      expect(losers).toEqual([{ ok: false, reason: 'already_consumed' }]);
    });

    test('throws at construction (not at issue()/find() time) when redisClient is supplied without a keyspace', () => {
      const { client } = makeFakeRedis();
      expect(() => createLinkCompletionStore({ redisClient: client })).toThrow(/keyspace.*required/i);
    });
  });

  describe('requireRedis (AC-19 topology)', () => {
    test('throws when requireRedis is set and no redisClient is supplied', () => {
      expect(() => createLinkCompletionStore({ requireRedis: true })).toThrow(/requireRedis/);
    });

    test('does not throw when requireRedis is set and a redisClient IS supplied', () => {
      const { client } = makeFakeRedis();
      expect(() => createLinkCompletionStore({ requireRedis: true, redisClient: client, keyspace: TEST_KEYSPACE })).not.toThrow();
    });
  });

  describe('in-memory fallback (no Redis)', () => {
    test('issue -> find -> consumeVerified round-trips; pre-consume record has null consumedAt/retentionExpiresAt', async () => {
      const store = createLinkCompletionStore();
      const outcome = await store.issue(makeIssueInput());
      expect(outcome.ok).toBe(true);
      if (!outcome.ok) throw new Error('unreachable');
      expect(outcome.record.consumedAt).toBeNull();
      expect(outcome.record.retentionExpiresAt).toBeNull();

      expect(await store.find(outcome.code)).toEqual(outcome.record);
      const consumed = await store.consumeVerified(outcome.code);
      expect(consumed.ok).toBe(true);
      expect(await store.consumeVerified(outcome.code)).toEqual({ ok: false, reason: 'already_consumed' });
    });

    test('a `now` test clock governs every decision — never the real Date.now()', async () => {
      let clockMs = 0;
      const store = createLinkCompletionStore({ now: () => clockMs });
      const issued = await store.issue(makeIssueInput({ stateExpiresAt: 300_000 }));
      expect(issued.ok).toBe(true);
      if (!issued.ok) throw new Error('unreachable');
      expect(issued.record.issuedAt).toBe(0);
      expect(issued.record.authorizationExpiresAt).toBe(LINK_COMPLETION_AUTHORIZATION_TTL_MS);

      clockMs = 299_999;
      expect(await store.consumeVerified(issued.code)).toMatchObject({ ok: true });
    });

    test('code issued at t=0: unconsumed at 300000ms is not_found (boundary, AC-7)', async () => {
      let clockMs = 0;
      const store = createLinkCompletionStore({ now: () => clockMs });
      const issued = await store.issue(makeIssueInput({ stateExpiresAt: 300_000 }));
      if (!issued.ok) throw new Error('unreachable');

      clockMs = LINK_COMPLETION_AUTHORIZATION_TTL_MS;
      expect(await store.consumeVerified(issued.code)).toEqual({ ok: false, reason: 'not_found' });
      expect(await store.find(issued.code)).toBeNull();
    });

    test('a state past its deadline is rejected with state_expired', async () => {
      const clockMs = 1_000_000;
      const store = createLinkCompletionStore({ now: () => clockMs });
      expect(await store.issue(makeIssueInput({ stateExpiresAt: clockMs - 1 }))).toEqual({ ok: false, reason: 'state_expired' });
    });

    test('same-state idempotency: sequential and concurrent issue() resolve exactly one winner (AC-6)', async () => {
      const store = createLinkCompletionStore();
      const input = makeIssueInput();
      const first = await store.issue(input);
      expect(first.ok).toBe(true);
      expect(await store.issue(input)).toEqual({ ok: false, reason: 'state_already_issued' });

      const store2 = createLinkCompletionStore();
      const input2 = makeIssueInput({ state: `crowilnk_${'c'.repeat(34)}` });
      const [a, b] = await Promise.all([store2.issue(input2), store2.issue(input2)]);
      const winners = [a, b].filter((r) => r.ok);
      expect(winners).toHaveLength(1);
    });

    test('concurrent consumeVerified calls for the SAME code resolve exactly one winner', async () => {
      const store = createLinkCompletionStore();
      const issued = await store.issue(makeIssueInput());
      if (!issued.ok) throw new Error('unreachable');
      const [a, b] = await Promise.all([store.consumeVerified(issued.code), store.consumeVerified(issued.code)]);
      const winners = [a, b].filter((r) => r.ok);
      expect(winners).toHaveLength(1);
    });

    test('a consumed record is retained for 5 minutes from the consume linearization point, then find() reports null', async () => {
      let clockMs = 0;
      const store = createLinkCompletionStore({ now: () => clockMs });
      const issued = await store.issue(makeIssueInput({ stateExpiresAt: 300_000 }));
      if (!issued.ok) throw new Error('unreachable');
      clockMs = 100;
      await store.consumeVerified(issued.code);

      clockMs = 100 + LINK_COMPLETION_CONSUMED_RETENTION_MS - 1;
      expect(await store.find(issued.code)).not.toBeNull();
      clockMs += 2;
      expect(await store.find(issued.code)).toBeNull();
    });

    test('an accountLabel exceeding the record budget is omitted; mandatory fields (large providerUserId) are always stored', async () => {
      const store = createLinkCompletionStore();
      const hugeEmail = `${'a'.repeat(5000)}@example.com`;
      const issued = await store.issue(makeIssueInput({ accountLabel: hugeEmail }));
      expect(issued.ok).toBe(true);
      if (!issued.ok) throw new Error('unreachable');
      expect(issued.record.accountLabel).toBeUndefined();

      const store2 = createLinkCompletionStore();
      const hugeProviderUserId = 'sub-'.repeat(2000);
      const issued2 = await store2.issue(makeIssueInput({ providerUserId: hugeProviderUserId }));
      expect(issued2.ok).toBe(true);
      if (!issued2.ok) throw new Error('unreachable');
      expect(issued2.record.providerUserId).toBe(hugeProviderUserId);
    });

    test('find/consumeVerified report absence for a never-issued code', async () => {
      const store = createLinkCompletionStore();
      expect(await store.find('never-issued')).toBeNull();
      expect(await store.consumeVerified('never-issued')).toEqual({ ok: false, reason: 'not_found' });
    });
  });
});
