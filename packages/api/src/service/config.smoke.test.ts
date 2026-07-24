/**
 * feature-redis-8-upgrade Phase 2 — Config settings-sync smoke (consumer
 * #5, required).
 *
 * Runs ONLY against the dedicated `crowi-test-redis` instance (Phase 1),
 * NEVER the shared `redis` service. Historically this was because
 * `ConfigService.setupPubSub()`'s `'config'` channel was fixed and global —
 * feature-redis-key-prefix §1/§2 scopes it to `crowi:<slug>:config` instead,
 * but this file's `fakeCrowi` fixtures all resolve the SAME instance slug
 * (`SMOKE_REDIS_KEY_PREFIX`, matching "replicas of one instance" so the
 * cross-replica relay this smoke asserts still happens), so a `PUBLISH`
 * here would still reach EVERY process sharing that same slug on that
 * Redis instance, including an unrelated worktree's running dev api on the
 * shared instance if it happened to resolve the same slug (see the spec's
 * "Config 設定同期の pub/sub" background). `crowi-test-redis` is
 * guaranteed to have no other subscriber, so this smoke is safe there and
 * nowhere else.
 *
 * Builds two independent `ConfigService` instances (real `setupPubSub()`,
 * unmodified production code) against a minimal fake `Crowi` — same
 * `{ redisOpts, redis, model }` shape `crowi/index.test.ts`'s existing
 * `.setupPubSub is a no-op...` test already uses for the degraded case;
 * here both `redisOpts` (real, pointed at `crowi-test-redis`) and `redis`
 * (any truthy value — `setupPubSub` only null-checks it, the real
 * publisher/subscriber clients it opens are independent of this field) are
 * populated so the real pub/sub path runs.
 */
import ConfigService from 'src/service/config';
import { markRedisSmokeRan, REDIS_SMOKE_URLS, redisSmokeReachable, waitUntil } from 'src/test/redis-smoke';
import { buildRedisOpts } from 'src/util/redis-opts';

const describeMaybe = redisSmokeReachable.config ? describe : describe.skip;

/**
 * Every `fakeCrowi` fixture in this file shares this `REDIS_KEY_PREFIX`
 * (feature-redis-key-prefix §1/§2) so instance A and B resolve the SAME
 * `crowi:config-smoke:config` pub/sub channel — matching "two replicas of
 * the same Crowi instance", which is exactly the cross-replica relay this
 * smoke test asserts.
 */
const SMOKE_REDIS_KEY_PREFIX = 'config-smoke';

/**
 * Minimal fake `Crowi` — only the fields `ConfigService`'s constructor +
 * `setupPubSub()` + `postUpdate()` read. `model()` backs `this.configModel`
 * (constructor) and the subscriber's `load()` call; `setupMailer` backs
 * `postUpdate()`; `getBaseUrl`/`getEnv` back `resolveRedisKeyspace()`
 * (feature-redis-key-prefix §1/§2 — `setupPubSub()` resolves the pub/sub
 * channel through these). Same narrow-fixture pattern `crowi/index.test.ts`
 * already uses for `ConfigService`.
 */
function fakeCrowi(loadAllConfig: jest.Mock, setupMailer: jest.Mock, updateByParams: jest.Mock = jest.fn(async () => undefined)): unknown {
  return {
    redisOpts: buildRedisOpts(REDIS_SMOKE_URLS.config, true),
    redis: {}, // truthy — setupPubSub only null-checks this field
    model: () => ({ loadAllConfig, updateByParams }),
    setupMailer,
    getBaseUrl: () => null,
    getEnv: () => ({ REDIS_KEY_PREFIX: SMOKE_REDIS_KEY_PREFIX }) as unknown as NodeJS.ProcessEnv,
  };
}

describeMaybe('Config pub/sub smoke (real Redis 8, dedicated crowi-test-redis instance)', () => {
  beforeAll(() => {
    markRedisSmokeRan('config');
  });

  it("instance A's notifyUpdated() drives instance B's subscriber to run load() + postUpdate() (setupMailer + registered listener)", async () => {
    const loadAllConfigA = jest.fn(async () => ({}));
    const setupMailerA = jest.fn(async () => undefined);
    const loadAllConfigB = jest.fn(async () => ({}));
    const setupMailerB = jest.fn(async () => undefined);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const serviceA = new ConfigService(fakeCrowi(loadAllConfigA, setupMailerA) as any);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const serviceB = new ConfigService(fakeCrowi(loadAllConfigB, setupMailerB) as any);

    try {
      await Promise.all([serviceA.setupPubSub(), serviceB.setupPubSub()]);
      expect(serviceA.pubSub.publisher).not.toBeNull();
      expect(serviceB.pubSub.subscriber).not.toBeNull();
      // Instance-scoped (feature-redis-key-prefix §1/§2), not the legacy
      // global `'config'` literal — both replicas resolve the same channel
      // because they share `SMOKE_REDIS_KEY_PREFIX`.
      expect(serviceA.pubSub.channel).toBe(`crowi:${SMOKE_REDIS_KEY_PREFIX}:config`);
      expect(serviceB.pubSub.channel).toBe(`crowi:${SMOKE_REDIS_KEY_PREFIX}:config`);

      const changedListenerB = jest.fn();
      serviceB.onConfigChange(changedListenerB);

      await serviceA.notifyUpdated(['app']);

      await waitUntil(() => loadAllConfigB.mock.calls.length >= 1 && setupMailerB.mock.calls.length >= 1);
      expect(loadAllConfigB).toHaveBeenCalled();
      expect(setupMailerB).toHaveBeenCalled();
      expect(changedListenerB).toHaveBeenCalledWith(['app'], 'remote');

      // Instance A's own local update runs postUpdate() synchronously too
      // (the publish is fire-and-forget alongside it), but must not be
      // driven by B's subscriber — a sanity check that this is a genuine
      // two-instance relay, not a same-process echo.
      expect(setupMailerA).toHaveBeenCalled();
    } finally {
      // ConfigService has no teardown API of its own (per the spec) — the
      // test disconnects the publisher/subscriber clients it opened
      // directly.
      await Promise.all(
        [
          serviceA.pubSub.publisher?.disconnect(),
          serviceA.pubSub.subscriber?.disconnect(),
          serviceB.pubSub.publisher?.disconnect(),
          serviceB.pubSub.subscriber?.disconnect(),
        ].filter(Boolean),
      );
    }
  }, 20000);

  /**
   * feature-renderer-plugin-boundary Phase 3 spec §6.2/AC5 — the
   * `security:linkCardEnabled` toggle's durable write path
   * (`ConfigService.saveConfigValueDurable`), exercised cross-replica
   * for real over the dedicated `crowi-test-redis` pub/sub channel:
   * a successful durable write on instance A updates A's own memory
   * immediately (before any publish round-trip) and drives instance B's
   * subscriber to reload + reflect the same value once its `load()`
   * fires — same "handling replica updates first, remote replica
   * catches up after pub/sub reload" contract the AC requires.
   */
  it("instance A's successful saveConfigValueDurable() flips A's own memory immediately and drives instance B to the same value after pub/sub reload", async () => {
    const updateByParamsA = jest.fn(async () => undefined);
    const loadAllConfigA = jest.fn(async () => ({ crowi: {} }));
    const setupMailerA = jest.fn(async () => undefined);
    const loadAllConfigB = jest.fn(async () => ({ crowi: { 'security:linkCardEnabled': false } }));
    const setupMailerB = jest.fn(async () => undefined);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const serviceA = new ConfigService(fakeCrowi(loadAllConfigA, setupMailerA, updateByParamsA) as any);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const serviceB = new ConfigService(fakeCrowi(loadAllConfigB, setupMailerB) as any);

    try {
      await Promise.all([serviceA.setupPubSub(), serviceB.setupPubSub()]);

      await serviceA.saveConfigValueDurable('crowi', 'security:linkCardEnabled', false);
      expect(updateByParamsA).toHaveBeenCalledWith('crowi', 'security:linkCardEnabled', false);
      // Handling replica's own memory flips synchronously, before any
      // remote round-trip.
      expect(serviceA.config.crowi?.['security:linkCardEnabled']).toBe(false);

      await waitUntil(() => loadAllConfigB.mock.calls.length >= 1);
      expect(serviceB.config.crowi?.['security:linkCardEnabled']).toBe(false);
    } finally {
      await Promise.all(
        [
          serviceA.pubSub.publisher?.disconnect(),
          serviceA.pubSub.subscriber?.disconnect(),
          serviceB.pubSub.publisher?.disconnect(),
          serviceB.pubSub.subscriber?.disconnect(),
        ].filter(Boolean),
      );
    }
  }, 20000);

  it('a rejected Mongo write propagates, leaves memory unmutated, and never reaches instance B (zero publish on failure)', async () => {
    const updateByParamsA = jest.fn(async () => {
      throw new Error('mongo down');
    });
    const loadAllConfigA = jest.fn(async () => ({ crowi: {} }));
    const setupMailerA = jest.fn(async () => undefined);
    const loadAllConfigB = jest.fn(async () => ({ crowi: {} }));
    const setupMailerB = jest.fn(async () => undefined);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const serviceA = new ConfigService(fakeCrowi(loadAllConfigA, setupMailerA, updateByParamsA) as any);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const serviceB = new ConfigService(fakeCrowi(loadAllConfigB, setupMailerB) as any);

    try {
      await Promise.all([serviceA.setupPubSub(), serviceB.setupPubSub()]);

      await expect(serviceA.saveConfigValueDurable('crowi', 'security:linkCardEnabled', false)).rejects.toThrow('mongo down');
      expect(serviceA.config.crowi).toBeUndefined();

      // Give any (incorrect) publish a moment to arrive at B before
      // asserting it never did.
      await new Promise((resolve) => setTimeout(resolve, 250));
      expect(loadAllConfigB).not.toHaveBeenCalled();
    } finally {
      await Promise.all(
        [
          serviceA.pubSub.publisher?.disconnect(),
          serviceA.pubSub.subscriber?.disconnect(),
          serviceB.pubSub.publisher?.disconnect(),
          serviceB.pubSub.subscriber?.disconnect(),
        ].filter(Boolean),
      );
    }
  }, 20000);
});
