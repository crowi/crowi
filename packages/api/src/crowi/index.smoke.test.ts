/**
 * feature-redis-8-upgrade Phase 2 — boot connection + TLS smoke (consumer
 * #8).
 *
 *   (a) success path (gated on the shared `redis` target): a real
 *       `Crowi.setupRedisClient()` (unmocked) against real Redis 8 —
 *       `crowi.redis` becomes non-null and a simple command (`PING`) works.
 *   (b) TLS handshake (gated on the TLS fixture target, unconditional once
 *       reachable — the TLS shape bug is already fixed by `fee9c9a4`): a
 *       real `rediss://` connection succeeds for BOTH the shared node-redis
 *       v4 client (`setupRedisClient()`) and the collab-side ioredis client
 *       — reached via `buildCollabRedisExtension()` itself (unmodified
 *       production code, same construction path `attachCollabServer` uses).
 *
 *       `buildCollabRedisExtension()` can NOT be called directly inside this
 *       (or any) Jest test file — `require('@hocuspocus/extension-redis')`
 *       transitively pulls in `@hocuspocus/server`'s CJS build, which itself
 *       `require()`s `crossws/adapters/node` (ESM-only), which Jest's CJS
 *       transform cannot parse. This is the exact same constraint that
 *       forces consumer #1's collab smoke to run
 *       `redis-smoke-harness.ts` in a separate `tsx` process instead of
 *       constructing `Hocuspocus` in-process (see that file's doc comment).
 *       So this TLS sub-scenario reuses the SAME harness + the SAME
 *       parent-process client helper (`redis-smoke-harness-client.ts`):
 *       spawning one harness pointed at the `rediss://` fixture already
 *       forces (and asserts, inside the harness itself before it signals
 *       ready) a real connect+PING on the extension's `pub` client — so
 *       successfully reaching "ready" IS the proof the collab-side ioredis
 *       client completed the TLS handshake, with zero re-derivation of
 *       connect options on this side and zero test-only exports added to
 *       `extension-redis.ts`.
 *
 * Dead-port failure / ACL auth / `ConfigService.setupPubSub()` degrade are
 * explicitly OUT of this smoke's scope — `crowi/index.test.ts`'s existing
 * `boot degrade when Redis is configured but unreachable` describe block
 * already covers them as pure regression tests that don't involve a real
 * Redis 8 server (see the spec's "boot 接続 / TLS 接続確認" design note).
 *
 * Reuses the shared `crowi` singleton `src/test/setup.ts` boots for every
 * file in this project (real Mongo, `crowi.redis === null` by default since
 * the test harness never sets `REDIS_URL`) — same save/restore-`redisOpts`
 * pattern `crowi/index.test.ts`'s own degrade test already uses, so this
 * file never leaves a mutated shared singleton behind for the next test in
 * the same worker.
 */
import { crowi } from 'src/test/setup';
import { markRedisSmokeRan, redisSmokeReachable, REDIS_SMOKE_URLS } from 'src/test/redis-smoke';
import { spawnRedisSmokeHarness, stopRedisSmokeHarness } from 'src/collab/redis-smoke-harness-client';

/**
 * Shared by both sub-scenarios below: point the shared `crowi` singleton's
 * `redisOpts` at `url`, run a real `setupRedisClient()` + `PING`, then
 * restore whatever `redisOpts`/`redis` this file found on entry — same
 * save/restore-`redisOpts` pattern `crowi/index.test.ts`'s own degrade test
 * uses, so this file never leaves a mutated shared singleton behind for the
 * next test in the same worker.
 */
async function verifyRealRedisConnection(url: string, rejectUnauthorized: boolean): Promise<void> {
  const savedOpts = crowi.redisOpts;
  const savedRedis = crowi.redis;
  try {
    crowi.redisOpts = crowi.buildRedisOpts(url, rejectUnauthorized);
    crowi.redis = null;
    await crowi.setupRedisClient();
    expect(crowi.redis).not.toBeNull();
    expect(await crowi.redis.ping()).toBe('PONG');
  } finally {
    if (crowi.redis && crowi.redis !== savedRedis) {
      await crowi.redis.disconnect().catch(() => undefined);
    }
    crowi.redisOpts = savedOpts;
    crowi.redis = savedRedis;
  }
}

describe('boot connection + TLS smoke (real Redis 8)', () => {
  const describeSharedMaybe = redisSmokeReachable.shared ? describe : describe.skip;
  const describeTlsMaybe = redisSmokeReachable.tls ? describe : describe.skip;

  beforeAll(() => {
    // Marked once regardless of which sub-scenario(s) below actually ran —
    // "boot" is a single category covering both the success path and the
    // TLS sub-scenario (see the spec's category list). If NEITHER target is
    // reachable this `beforeAll` still runs (describe blocks below are what
    // skip, not this top-level one) — recording the marker even when both
    // inner scenarios are locally skipped mirrors every other smoke file's
    // "record that this category's file executed" contract, and CI (where
    // Phase 1 guarantees both targets) always exercises at least the
    // success-path assertions below.
    markRedisSmokeRan('boot');
  });

  describeSharedMaybe('success path', () => {
    it('setupRedisClient() against a real Redis 8 makes crowi.redis non-null and PING succeeds', async () => {
      await verifyRealRedisConnection(REDIS_SMOKE_URLS.shared, true);
    }, 15000);
  });

  describeTlsMaybe('TLS handshake', () => {
    it('setupRedisClient() completes a real TLS handshake against the rediss:// fixture (shared node-redis v4 client)', async () => {
      // Self-signed test fixture — `rejectUnauthorized: false` matches
      // `redis-opts.test.ts`'s existing TLS repro (handshake succeeds; a
      // strict CA chain is explicitly out of this smoke's scope).
      await verifyRealRedisConnection(REDIS_SMOKE_URLS.tls, false);
    }, 15000);

    it('the collab-side ioredis client (buildCollabRedisExtension, unmodified production code) also completes the same TLS handshake', async () => {
      // Same self-signed fixture as the shared-client scenario above —
      // `parseRedisUrlForIoredis` (private to `extension-redis.ts`) derives
      // `tls.rejectUnauthorized` from this env var, read inside the harness
      // child process (forwarded via `extraEnv` below), not here.
      const harness = await spawnRedisSmokeHarness('boot-tls-collab', REDIS_SMOKE_URLS.tls, { REDIS_REJECT_UNAUTHORIZED: '0' });
      // Reaching this point already proves the extension's `pub` ioredis
      // client connected and PONGed over TLS (see
      // `redis-smoke-harness.ts`'s eager connectivity self-check) —
      // `spawnRedisSmokeHarness` would have rejected otherwise (the harness
      // process throws and exits non-zero before ever emitting "ready").
      await stopRedisSmokeHarness(harness);
    }, 25000);
  });
});
