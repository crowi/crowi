/**
 * feature-redis-8-upgrade Phase 2 — Config settings-sync smoke (consumer
 * #5, required).
 *
 * Runs ONLY against the dedicated `crowi-test-redis` instance (Phase 1),
 * NEVER the shared `redis` service — `ConfigService.setupPubSub()`'s
 * `'config'` channel is fixed and global: a `PUBLISH` there makes EVERY
 * process sharing that Redis instance unconditionally run
 * `load()`/`postUpdate()`/`setupMailer()`, including an unrelated worktree's
 * running dev api on the shared instance (see the spec's "Config 設定同期の
 * pub/sub" background). `crowi-test-redis` is guaranteed to have no other
 * subscriber, so this smoke is safe there and nowhere else.
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
 * Minimal fake `Crowi` — only the fields `ConfigService`'s constructor +
 * `setupPubSub()` + `postUpdate()` read. `model()` backs `this.configModel`
 * (constructor) and the subscriber's `load()` call; `setupMailer` backs
 * `postUpdate()`. Same narrow-fixture pattern `crowi/index.test.ts` already
 * uses for `ConfigService`.
 */
function fakeCrowi(loadAllConfig: jest.Mock, setupMailer: jest.Mock): unknown {
  return {
    redisOpts: buildRedisOpts(REDIS_SMOKE_URLS.config, true),
    redis: {}, // truthy — setupPubSub only null-checks this field
    model: () => ({ loadAllConfig }),
    setupMailer,
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
      await serviceA.setupPubSub();
      await serviceB.setupPubSub();
      expect(serviceA.pubSub.publisher).not.toBeNull();
      expect(serviceB.pubSub.subscriber).not.toBeNull();

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
});
