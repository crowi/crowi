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

      // --- viewer-list change (join) ---
      const receivedPageIds: string[] = [];
      const unsubscribeViewers = serviceB.subscribe('viewers', (changedPageId) => {
        if (changedPageId === pageId) receivedPageIds.push(changedPageId);
      });
      await serviceA.join(pageId, viewer);
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
      await serviceA.leave(pageId, viewer.userId);
    } finally {
      // Ownership-aware teardown: each service's own `shutdown()` closes
      // its 1 duplicate subscriber only; the primary clients this test
      // itself `connect()`-ed are disconnected separately.
      await Promise.all([serviceA?.shutdown(), serviceB?.shutdown()].filter(Boolean));
      await Promise.all([clientA.disconnect(), clientB.disconnect()]);
    }
  }, 20000);
});
