/**
 * `link-completion` store smoke test
 * (Redis-consumer #8 of 9; shared Redis 8 instance, real `EVAL`/`cjson`/
 * `KEYS`/`ARGV`/`PX`/`TIME` — `link-completion.test.ts` covers the same
 * contracts against a fake client for fast, exhaustive boundary coverage;
 * this file's job is only to prove the two Lua scripts actually run
 * correctly, INCLUDING their `redis.call('TIME')` calls, against a real
 * Redis server).
 *
 * Deliberately does NOT wrap `time()` with a virtual clock the way earlier
 * revisions of this file did: `issue()`/`consumeVerified()` fetch `TIME`
 * ATOMICALLY INSIDE their own Lua scripts (see `link-completion.ts`'s
 * module doc comment) — a JS-side `MinimalLinkCompletionRedisClient#time()`
 * override has ZERO effect on either method's stamped
 * `issuedAt`/`authorizationExpiresAt`/`consumedAt`/`retentionExpiresAt`, so
 * a test that only mocks `time()` and asserts those fields would silently
 * stop testing anything. Two different techniques replace it:
 *
 *   1. Real wall-clock tolerance assertions (`issuedAt`/`consumedAt` land
 *      within a few seconds of `Date.now()`) for the ordinary round trip.
 *   2. A DEDICATED test that poisons `client.time()` with an absurd value
 *      and proves `issue()`/`consumeVerified()` ignore it completely —
 *      direct proof that the real Lua scripts' own `TIME` call, not this
 *      JS-level wrapper, is what's authoritative.
 *
 * The exact 299999ms/300000ms boundary math stays the fake client's job
 * (`link-completion.test.ts`) — real Redis's own clock can't be paused or
 * rewound. This file instead proves the SAME mechanisms (the authorization
 * deadline gate, consumed-first ordering, the state-marker `SET NX` gate)
 * execute correctly against real Redis, either via a genuine short real
 * sleep (deadline test) or by seeding a key directly in this store's own
 * key scheme (gate tests) — no clock trickery either way.
 */
import crypto from 'node:crypto';
import type { createClient } from 'redis';
import type Crowi from 'src/crowi';
import {
  createLinkCompletionStore,
  LINK_COMPLETION_AUTHORIZATION_TTL_MS,
  LINK_COMPLETION_CONSUMED_RETENTION_MS,
  type LinkCompletionIssue,
  type LinkCompletionRecord,
  type MinimalLinkCompletionRedisClient,
} from 'src/service/link-completion';
import { markRedisSmokeRan, REDIS_SMOKE_URLS, redisSmokeReachable, uniqueRedisSmokeId, withRedisClient } from 'src/test/redis-smoke';
import { resolveRedisKeyspace } from 'src/util/redis-keyspace';

const describeMaybe = redisSmokeReachable.shared ? describe : describe.skip;

const SMOKE_KEYSPACE = resolveRedisKeyspace({
  getBaseUrl: () => null,
  getEnv: () => ({ REDIS_KEY_PREFIX: 'link-completion-smoke' }) as unknown as NodeJS.ProcessEnv,
} as unknown as Crowi);

/** Mirrors `link-completion.ts`'s private key scheme so this file can `DEL`/seed exactly the keys a run created — see the module's `stateKeyFor`/`recordKeyFor`/`consumedKeyFor`. */
function sha256Hex(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}
function stateKeyFor(state: string): string {
  return SMOKE_KEYSPACE.key('link-completion-state', sha256Hex(state));
}
function recordKeyFor(code: string): string {
  return SMOKE_KEYSPACE.key('link-completion-record', sha256Hex(code));
}
function consumedKeyFor(code: string): string {
  return SMOKE_KEYSPACE.key('link-completion-consumed', sha256Hex(code));
}

/** Generous tolerance for comparing a Lua-stamped (real Redis `TIME`) timestamp against this process's `Date.now()` — covers normal network/scheduling jitter between the two hosts/processes without weakening what the assertion actually proves (a poisoned/wrong clock is off by minutes-to-never, not milliseconds). */
const REAL_CLOCK_TOLERANCE_MS = 15_000;

function makeInput(overrides: Partial<LinkCompletionIssue> = {}): LinkCompletionIssue {
  return {
    state: overrides.state ?? uniqueRedisSmokeId('link-completion-state'),
    stateExpiresAt: overrides.stateExpiresAt ?? Date.now() + 300_000,
    userId: overrides.userId ?? uniqueRedisSmokeId('user'),
    authVersion: overrides.authVersion ?? 0,
    provider: overrides.provider ?? 'google',
    providerUserId: overrides.providerUserId ?? uniqueRedisSmokeId('sub'),
    ...(overrides.accountLabel !== undefined ? { accountLabel: overrides.accountLabel } : {}),
  };
}

/** Adapts a real `withRedisClient` connection to `MinimalLinkCompletionRedisClient` — shared by every test below so the `get`/`eval` pass-through isn't repeated per call site. Seeding writes use the raw connection instead, since the store's own surface has no `set`. `timeOverride` replaces `time()` alone (used by the poisoned-clock test); every other test lets `time()` fall through to the real connection. */
function makeClient(real: ReturnType<typeof createClient>, timeOverride?: () => Promise<Date>): MinimalLinkCompletionRedisClient {
  return {
    get: (key) => real.get(key),
    eval: (script, options) => real.eval(script, options) as Promise<unknown>,
    time: timeOverride ?? (() => real.time()),
  };
}

function makeSeededRecord(overrides: Partial<LinkCompletionRecord> = {}): LinkCompletionRecord {
  const now = Date.now();
  return {
    userId: overrides.userId ?? uniqueRedisSmokeId('user'),
    authVersion: overrides.authVersion ?? 0,
    provider: overrides.provider ?? 'google',
    providerUserId: overrides.providerUserId ?? uniqueRedisSmokeId('sub'),
    issuedAt: overrides.issuedAt ?? now,
    authorizationExpiresAt: overrides.authorizationExpiresAt ?? now + LINK_COMPLETION_AUTHORIZATION_TTL_MS,
    consumedAt: overrides.consumedAt ?? null,
    retentionExpiresAt: overrides.retentionExpiresAt ?? null,
    ...(overrides.accountLabel !== undefined ? { accountLabel: overrides.accountLabel } : {}),
  };
}

describeMaybe('link-completion smoke (real Redis 8)', () => {
  beforeAll(() => {
    markRedisSmokeRan('link-completion');
  });

  it('issue -> find -> consumeVerified round-trips against real Redis (real EVAL/cjson/KEYS/ARGV/PX/TIME), with issuedAt/consumedAt tracking real wall-clock time and the state-marker TTL set correctly', async () => {
    await withRedisClient(REDIS_SMOKE_URLS.shared, async (real) => {
      const client = makeClient(real);
      const store = createLinkCompletionStore({ redisClient: client, keyspace: SMOKE_KEYSPACE });
      const beforeIssue = Date.now();
      const input = makeInput();

      const issued = await store.issue(input);
      expect(issued.ok).toBe(true);
      if (!issued.ok) throw new Error('unreachable');
      // The real Lua script stamped these from its own `redis.call('TIME')`
      // — never from this process's clock — so we can only assert they
      // land close to it, not equal it.
      expect(Math.abs(issued.record.issuedAt - beforeIssue)).toBeLessThan(REAL_CLOCK_TOLERANCE_MS);
      expect(issued.record.authorizationExpiresAt).toBe(issued.record.issuedAt + LINK_COMPLETION_AUTHORIZATION_TTL_MS);

      // The record key is real, PX-backed Redis storage — not a fixture.
      const recordKey = recordKeyFor(issued.code);
      const ttlMs = await real.pTTL(recordKey);
      expect(ttlMs).toBeGreaterThan(0);
      expect(ttlMs).toBeLessThanOrEqual(LINK_COMPLETION_AUTHORIZATION_TTL_MS + 5000);

      // Missing from earlier revisions of this file (review finding): the
      // state marker's own TTL, which the ISSUE_SCRIPT derives from
      // `stateExpiresAt - <its own TIME read>`, must also be real,
      // PX-backed Redis storage in the right ballpark (residual ~300s here,
      // since `input.stateExpiresAt` is `Date.now() + 300_000`).
      const stateTtlMs = await real.pTTL(stateKeyFor(input.state));
      expect(stateTtlMs).toBeGreaterThan(0);
      expect(stateTtlMs).toBeLessThanOrEqual(300_000 + 5000);

      const found = await store.find(issued.code);
      expect(found).toEqual(issued.record);

      const beforeConsume = Date.now();
      const consumed = await store.consumeVerified(issued.code);
      expect(consumed.ok).toBe(true);
      if (!consumed.ok) throw new Error('unreachable');
      expect(Math.abs(consumed.record.consumedAt! - beforeConsume)).toBeLessThan(REAL_CLOCK_TOLERANCE_MS);
      expect(consumed.record.retentionExpiresAt).toBe(consumed.record.consumedAt! + LINK_COMPLETION_CONSUMED_RETENTION_MS);

      // Real re-consume against real Redis: single winner, sibling marker present.
      expect(await store.consumeVerified(issued.code)).toEqual({ ok: false, reason: 'already_consumed' });
      // Retention TTL re-armed the record key to the 5-minute window (same
      // numeric value as the authorization TTL, so assert against the
      // retention constant directly rather than a strict ">" comparison).
      const consumedTtlMs = await real.pTTL(recordKey);
      expect(consumedTtlMs).toBeGreaterThan(0);
      expect(consumedTtlMs).toBeLessThanOrEqual(LINK_COMPLETION_CONSUMED_RETENTION_MS);
      expect(consumedTtlMs).toBeGreaterThan(LINK_COMPLETION_CONSUMED_RETENTION_MS - 5000);

      await real.del([stateKeyFor(input.state), recordKey, consumedKeyFor(issued.code)]);
    });
  }, 15000);

  it("issue()/consumeVerified() ignore a poisoned client.time() entirely — Redis's own in-script TIME is authoritative, not this JS-level wrapper", async () => {
    await withRedisClient(REDIS_SMOKE_URLS.shared, async (real) => {
      // Wildly wrong on purpose: if the store's real backend ever fell back
      // to consulting this method for `issue()`/`consumeVerified()`'s own
      // timestamps, the assertions below (which compare against the REAL
      // `Date.now()`) would fail loudly instead of silently passing.
      const poisonedTime = new Date(0);
      const client = makeClient(real, async () => poisonedTime);
      const store = createLinkCompletionStore({ redisClient: client, keyspace: SMOKE_KEYSPACE });
      const input = makeInput();

      const beforeIssue = Date.now();
      const issued = await store.issue(input);
      expect(issued.ok).toBe(true);
      if (!issued.ok) throw new Error('unreachable');
      expect(Math.abs(issued.record.issuedAt - beforeIssue)).toBeLessThan(REAL_CLOCK_TOLERANCE_MS);
      expect(issued.record.issuedAt).not.toBe(poisonedTime.getTime());

      const beforeConsume = Date.now();
      const consumed = await store.consumeVerified(issued.code);
      expect(consumed.ok).toBe(true);
      if (!consumed.ok) throw new Error('unreachable');
      expect(Math.abs(consumed.record.consumedAt! - beforeConsume)).toBeLessThan(REAL_CLOCK_TOLERANCE_MS);
      expect(consumed.record.consumedAt).not.toBe(poisonedTime.getTime());

      // NOT calling store.find() here on purpose — find()'s liveness check
      // legitimately consults client.time() by design (see link-completion.ts's
      // module doc comment), so calling it against this deliberately-poisoned
      // client would just prove find()'s own documented dependency, not the
      // property this test targets.
      await real.del([stateKeyFor(input.state), recordKeyFor(issued.code), consumedKeyFor(issued.code)]);
    });
  }, 15000);

  it('same-state issue is idempotent for real, concurrent callers against real Redis — exactly one winner', async () => {
    await withRedisClient(REDIS_SMOKE_URLS.shared, async (real) => {
      const client = makeClient(real);
      const store = createLinkCompletionStore({ redisClient: client, keyspace: SMOKE_KEYSPACE });
      const input = makeInput();

      const [a, b] = await Promise.all([store.issue(input), store.issue(input)]);
      const winners = [a, b].filter((r) => r.ok);
      const losers = [a, b].filter((r) => !r.ok);
      expect(winners).toHaveLength(1);
      expect(losers).toEqual([{ ok: false, reason: 'state_already_issued' }]);

      const winnerCode = winners[0].ok ? winners[0].code : null;
      if (winnerCode) {
        await real.del([stateKeyFor(input.state), recordKeyFor(winnerCode), consumedKeyFor(winnerCode)]);
      }
    });
  }, 15000);

  it('a winner who consumes with a tight deadline leaves a racing loser already_consumed even after the ORIGINAL deadline has genuinely elapsed (consumed-first ordering, real Redis, real short wait — no clock injection)', async () => {
    await withRedisClient(REDIS_SMOKE_URLS.shared, async (real) => {
      const client = makeClient(real);
      const store = createLinkCompletionStore({ redisClient: client, keyspace: SMOKE_KEYSPACE });
      const input = makeInput();
      const issued = await store.issue(input);
      if (!issued.ok) throw new Error('unreachable');

      // Winner consumes immediately, comfortably inside the real 300s window.
      const winner = await store.consumeVerified(issued.code);
      expect(winner.ok).toBe(true);

      // Directly rewrite the just-consumed record's `authorizationExpiresAt`
      // to a moment already in the past — simulating "a racing loser's
      // consume attempt lands after the ORIGINAL deadline" without waiting
      // 5 real minutes. The sibling marker (real, set by the winner's own
      // consume above) is untouched, so this exercises the SAME
      // consumed-first branch order the real CONSUME_SCRIPT takes for a
      // genuinely late loser.
      const recordKey = recordKeyFor(issued.code);
      const raw = await real.get(recordKey);
      if (raw == null) throw new Error('unreachable — winner just wrote this key');
      const rewritten = { ...(JSON.parse(raw) as LinkCompletionRecord), authorizationExpiresAt: Date.now() - 1000 };
      await real.set(recordKey, JSON.stringify(rewritten), { PX: LINK_COMPLETION_CONSUMED_RETENTION_MS });

      expect(await store.consumeVerified(issued.code)).toEqual({ ok: false, reason: 'already_consumed' });

      await real.del([stateKeyFor(input.state), recordKey, consumedKeyFor(issued.code)]);
    });
  }, 15000);

  it('consumeVerified() checks the authorization deadline against real Redis TIME — a seeded, never-consumed, past-deadline record is not_found (and find() agrees)', async () => {
    await withRedisClient(REDIS_SMOKE_URLS.shared, async (real) => {
      const client = makeClient(real);
      const store = createLinkCompletionStore({ redisClient: client, keyspace: SMOKE_KEYSPACE });
      const code = crypto.randomBytes(32).toString('base64url');
      const record = makeSeededRecord({ authorizationExpiresAt: Date.now() - 10_000 });
      const recordKey = recordKeyFor(code);
      await real.set(recordKey, JSON.stringify(record), { PX: 60_000 });

      expect(await store.consumeVerified(code)).toEqual({ ok: false, reason: 'not_found' });
      expect(await store.find(code)).toBeNull();

      await real.del([recordKey, consumedKeyFor(code)]);
    });
  }, 15000);

  it("issue()'s state-marker SET NX gate blocks a real caller against real Redis when the marker key was seeded directly", async () => {
    await withRedisClient(REDIS_SMOKE_URLS.shared, async (real) => {
      const client = makeClient(real);
      const store = createLinkCompletionStore({ redisClient: client, keyspace: SMOKE_KEYSPACE });
      const input = makeInput();
      await real.set(stateKeyFor(input.state), '1', { PX: 60_000 });

      expect(await store.issue(input)).toEqual({ ok: false, reason: 'state_already_issued' });

      await real.del([stateKeyFor(input.state)]);
    });
  }, 15000);
});
