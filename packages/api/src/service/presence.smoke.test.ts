/**
 * feature-redis-8-upgrade Phase 2 — presence smoke (consumer #3, required).
 *
 * Real Redis 8, real production construction path (`createPresenceService`,
 * no new seam — `feature-presence-generic-feed-bus` owns that refactor).
 * Two independent `PresenceService` instances, each backed by its OWN real
 * `redis` v4 primary client (own 1 `duplicate()` subscriber internally,
 * multiplexing every feed on the single generic feed channel), exercise the
 * cross-instance viewer-list / page-updated / comment-changed pub/sub relay
 * against the shared `redis` target (Phase 1). Isolation is via a
 * run-and-call-unique `pageId` — no new production seam per the spec's
 * "やらないこと".
 *
 * feature-redis-subscriber-crash-fix — AC-5, opt-in Redis-restart check
 * (NOT part of the automated test below, and NOT run in CI / normal
 * `pnpm test`): `createRedisPresenceService`'s dedicated feed subscriber is
 * now built via `duplicateWithErrorHandler` (`src/util/redis-opts.ts`),
 * which attaches an `error` listener before the subscriber ever
 * `connect()`s. The unit-level proof that this stops a process crash lives
 * in `presence.test.ts` ("subscriber outage survives"); what only a REAL
 * Redis restart can prove is that node-redis's OWN reconnect + native
 * channel resubscribe (not something this change adds or owns — see the
 * spec's "やらないこと": no self-managed generation/epoch/reconciliation)
 * actually restores the SAME feed channel this file's `join` test above
 * subscribes, so a live api process keeps receiving cross-instance
 * `viewers` / `page-updated` / `comment-changed` messages after Redis comes
 * back — not just that the process avoided crashing.
 *
 * This is deliberately NOT automated: the spec's "やらないこと" rules out
 * an API-restart test seam, and this suite's shared Redis target
 * (`REDIS_SMOKE_URLS.shared`) is used by 7 OTHER smoke categories plus
 * dev / CI — restarting it here would break every concurrent consumer.
 * Run it by hand, against a Redis instance YOU alone own (never the shared
 * `crowi-redis` dev container, CI's Redis, or another engineer's
 * container), whenever this helper or the presence subscriber wiring
 * changes:
 *
 *   1. Start an isolated Redis + a Crowi api instance pointed at it (e.g.
 *      `docker run --rm -p 16379:6379 redis:8` and
 *      `REDIS_URL=redis://localhost:16379 pnpm --filter @crowi/api dev`,
 *      or a disposable `docker compose` stack — anything not shared).
 *   2. Open the `/presence` WebSocket for some page on that api instance
 *      (or otherwise drive a `join`) so the process resolves
 *      `createRedisPresenceService` and its subscriber is live.
 *   3. Record the api process's identity before the restart: the OS PID
 *      (`pgrep -f 'crowi.*api'` or the equivalent for however you started
 *      it) if running bare, or `docker inspect --format
 *      '{{.State.Pid}}' <api-container>` and `docker inspect --format
 *      '{{.RestartCount}}' <api-container>` if containerized.
 *   4. Restart ONLY the Redis instance from step 1 (`docker restart
 *      <that-redis-container>` or equivalent) — never touch the api
 *      process/container itself.
 *   5. Immediately after Redis comes back, re-check the api process's PID
 *      / `RestartCount` from step 3 — PASS requires BOTH to be UNCHANGED
 *      (the api process never crashed or was restarted by its supervisor;
 *      a differing PID/RestartCount is an automatic FAIL, independent of
 *      step 6).
 *   6. From a second client (or a second api instance sharing the same
 *      Redis + instance slug), publish/join again and confirm the FIRST
 *      api instance's `/presence` WebSocket still receives the
 *      cross-instance feed update — proving node-redis's native
 *      resubscribe restored the channel this file's automated test
 *      exercises, not just that the process is still alive.
 */
import { createClient } from 'redis';
import type Crowi from 'src/crowi';
import {
  type CommentChangedPayload,
  createPresenceService,
  type PageUpdatedPayload,
  type PresenceRedisClient,
  type PresenceService,
  type ViewerIdentity,
} from 'src/service/presence';
import { markRedisSmokeRan, REDIS_SMOKE_URLS, redisSmokeReachable, uniqueRedisSmokeId, waitUntil } from 'src/test/redis-smoke';
import { resolveRedisKeyspace } from 'src/util/redis-keyspace';

const describeMaybe = redisSmokeReachable.shared ? describe : describe.skip;

/**
 * `createPresenceService`'s Redis-backed overload now REQUIRES a
 * `RedisKeyspace` (feature-redis-key-prefix §1/§2 review round 3) — instance
 * A and B share this fixed `REDIS_KEY_PREFIX` so they resolve the SAME
 * keyspace, matching "two replicas of the same Crowi instance" (they are
 * expected to share pub/sub, which is exactly what this smoke test asserts).
 */
const SMOKE_KEYSPACE = resolveRedisKeyspace({
  getBaseUrl: () => null,
  getEnv: () => ({ REDIS_KEY_PREFIX: 'presence-smoke' }) as unknown as NodeJS.ProcessEnv,
} as unknown as Crowi);

describeMaybe('presence smoke (real Redis 8)', () => {
  beforeAll(() => {
    markRedisSmokeRan('presence');
  });

  it('join / publishPageUpdated / publishCommentChanged on one PresenceService instance reach subscribe(feed, ...) listeners (viewers / page-updated / comment-changed) of an independently-constructed second instance', async () => {
    // Own real primary client per instance — mirrors two separate api
    // replicas each holding their own `crowi.redis`.
    const clientA = createClient({ url: REDIS_SMOKE_URLS.shared });
    const clientB = createClient({ url: REDIS_SMOKE_URLS.shared });
    await Promise.all([clientA.connect(), clientB.connect()]);

    let serviceA: PresenceService | null = null;
    let serviceB: PresenceService | null = null;
    try {
      // `createPresenceService` types its param as the structural
      // `PresenceRedisClient`; the real node-redis v4 client satisfies it
      // (duplicate/connect/disconnect/hSet/hGet/hGetAll/hDel/expire/publish/subscribe).
      serviceA = await createPresenceService(clientA as unknown as PresenceRedisClient, SMOKE_KEYSPACE);
      serviceB = await createPresenceService(clientB as unknown as PresenceRedisClient, SMOKE_KEYSPACE);

      const pageId = uniqueRedisSmokeId('presence-page');
      const viewer: ViewerIdentity = { userId: uniqueRedisSmokeId('user'), username: 'smoke-user', displayName: 'Smoke User', avatarUrl: null };
      // Single simulated connection for this smoke test (feature-presence-
      // consistency-fixes defect 1 added a mandatory `connectionId` param).
      const connectionId = uniqueRedisSmokeId('conn');

      // --- viewer-list change (join) ---
      const receivedPageIds: string[] = [];
      const unsubscribeViewers = serviceB.subscribe('viewers', (changedPageId) => {
        if (changedPageId === pageId) receivedPageIds.push(changedPageId);
      });
      await serviceA.join(pageId, viewer, connectionId);
      await waitUntil(() => receivedPageIds.length >= 1);
      expect(receivedPageIds).toContain(pageId);
      unsubscribeViewers();

      // --- page-updated ---
      const pageUpdatedPayloads: PageUpdatedPayload[] = [];
      const unsubscribePageUpdated = serviceB.subscribe('page-updated', (changedPageId, payload) => {
        if (changedPageId === pageId) pageUpdatedPayloads.push(payload as PageUpdatedPayload);
      });
      const pageUpdatedPayload: PageUpdatedPayload = {
        pageId,
        revisionId: uniqueRedisSmokeId('rev'),
        editorUserId: viewer.userId,
        editorDisplayName: viewer.displayName,
      };
      await serviceA.publishPageUpdated(pageId, pageUpdatedPayload);
      await waitUntil(() => pageUpdatedPayloads.length >= 1);
      expect(pageUpdatedPayloads[0]).toEqual(pageUpdatedPayload);
      unsubscribePageUpdated();

      // --- comment-changed ---
      const commentChangedPayloads: CommentChangedPayload[] = [];
      const unsubscribeCommentChanged = serviceB.subscribe('comment-changed', (changedPageId, payload) => {
        if (changedPageId === pageId) commentChangedPayloads.push(payload as CommentChangedPayload);
      });
      const commentPayload: CommentChangedPayload = { pageId, commentId: uniqueRedisSmokeId('comment'), changeType: 'added', actorUserId: viewer.userId };
      await serviceA.publishCommentChanged(pageId, commentPayload);
      await waitUntil(() => commentChangedPayloads.length >= 1);
      expect(commentChangedPayloads[0]).toEqual(commentPayload);
      unsubscribeCommentChanged();

      // --- listViewers reflects the join above (real hash write, not just pub/sub) ---
      const viewers = await serviceA.listViewers(pageId);
      expect(viewers.map((v) => v.userId)).toContain(viewer.userId);

      // Explicit cleanup of the crowi:presence-smoke:presence:viewers:<pageId> hash this
      // test created: leave() HDELs this viewer's field via the real
      // production code path (Redis removes the hash key once its last
      // field is gone), rather than leaving it for VIEWER_HASH_TTL_SECONDS
      // (60s) to expire it.
      await serviceA.leave(pageId, viewer.userId, connectionId);
    } finally {
      // Ownership-aware teardown: each service's own `shutdown()` closes
      // its 1 duplicate subscriber only; the primary clients this test
      // itself `connect()`-ed are disconnected separately.
      await Promise.all([serviceA?.shutdown(), serviceB?.shutdown()].filter(Boolean));
      await Promise.all([clientA.disconnect(), clientB.disconnect()]);
    }
  }, 20000);
});
