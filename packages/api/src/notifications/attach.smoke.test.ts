// Pin a stable WS_TOKEN_SECRET before any token util is constructed —
// mirrors `attach.test.ts`.
process.env.WS_TOKEN_SECRET = process.env.WS_TOKEN_SECRET ?? 'test-ws-token-secret-base64-32bytes-=';

/**
 * feature-redis-8-upgrade Phase 2 — notifications invalidation smoke
 * (consumer #4, required).
 *
 * Real Redis 8, real production construction path (`attachNotificationsServer`,
 * unmodified) attached to 2 independent real `http.Server`s, each with its
 * OWN real `redis` v4 primary client (`crowi.redis`). A real WebSocket
 * client (a fresh `ws.WebSocket`, same as `attach.test.ts`) connects to
 * instance B's `/notifications/<userId>` with a genuine signed notifications
 * token (`createNotificationsTokenUtil()`, same pattern as `attach.test.ts`'s
 * `validTokenFor`). Once subscribed, instance A publishes on
 * `channelForUser(userId)` from its OWN client and the test asserts B's
 * socket — and only that socket — receives `{type:'changed'}`.
 */
import http from 'node:http';
import { AddressInfo } from 'node:net';
import { createClient } from 'redis';
import type Crowi from 'src/crowi';
import { stopNotificationsHttpServer } from 'src/test/notifications-test-server';
import { markRedisSmokeRan, REDIS_SMOKE_URLS, redisSmokeReachable, uniqueRedisSmokeId, waitUntil } from 'src/test/redis-smoke';
import { createNotificationsTokenUtil } from 'src/util/notifications-token';
import WebSocket from 'ws';
import { type AttachedNotifications, attachNotificationsServer, channelForUser } from './attach';

const describeMaybe = redisSmokeReachable.shared ? describe : describe.skip;

const validTokenFor = (userId: string): string => createNotificationsTokenUtil().signNotificationsToken({ selfUserId: userId }).token;

interface RealServer {
  httpServer: http.Server;
  port: number;
  attachment: AttachedNotifications;
  redisClient: ReturnType<typeof createClient>;
}

async function startRealServer(redisUrl: string): Promise<RealServer> {
  const redisClient = createClient({ url: redisUrl });
  await redisClient.connect();
  const httpServer = http.createServer();
  const crowiLike = { redis: redisClient } as unknown as Crowi;
  const attachment = await attachNotificationsServer(httpServer, crowiLike);
  await new Promise<void>((resolve) => httpServer.listen(0, '127.0.0.1', resolve));
  const port = (httpServer.address() as AddressInfo).port;
  return { httpServer, port, attachment, redisClient };
}

async function stopRealServer(server: RealServer): Promise<void> {
  await stopNotificationsHttpServer(server.httpServer, server.attachment);
  await server.redisClient.disconnect();
}

describeMaybe('notifications invalidation smoke (real Redis 8)', () => {
  beforeAll(() => {
    markRedisSmokeRan('notifications');
  });

  it('a publish on channelForUser(userId) from instance A reaches the authenticated WS socket connected to instance B, and only that userId', async () => {
    const [serverA, serverB] = await Promise.all([startRealServer(REDIS_SMOKE_URLS.shared), startRealServer(REDIS_SMOKE_URLS.shared)]);

    const userId = uniqueRedisSmokeId('notif-user');
    const otherUserId = uniqueRedisSmokeId('notif-other-user');
    const token = validTokenFor(userId);

    let ws: WebSocket | null = null;
    try {
      const messages: string[] = [];
      ws = new WebSocket(`ws://127.0.0.1:${serverB.port}/notifications/${userId}?token=${token}`);
      ws.on('message', (data: Buffer | string) => {
        messages.push(typeof data === 'string' ? data : data.toString('utf8'));
      });
      await new Promise<void>((resolve, reject) => {
        ws?.once('open', () => resolve());
        ws?.once('error', reject);
      });

      // Wait for B's subscriber to actually have subscribed the channel
      // before publishing — otherwise the publish could race the async
      // subscribe and land before anyone is listening.
      await waitUntil(async () => (await serverB.redisClient.pubSubNumSub(channelForUser(userId)))[channelForUser(userId)] > 0);

      // Publish on a DIFFERENT user's channel first — must not reach our socket.
      await serverA.redisClient.publish(channelForUser(otherUserId), JSON.stringify({ type: 'changed' }));
      // Then publish on the real channel — this DOES reach it. Because the
      // real Redis fans out in publish order and frames queue onto the
      // socket in that same order, any (erroneous) cross-user frame would
      // arrive before this one — so once this sentinel arrives, `messages`
      // must contain exactly it.
      await serverA.redisClient.publish(channelForUser(userId), JSON.stringify({ type: 'changed' }));

      await waitUntil(() => messages.length >= 1);
      expect(messages).toHaveLength(1);
      expect(JSON.parse(messages[0])).toEqual({ type: 'changed' });
    } finally {
      // Ownership-aware teardown: WS close → both instances'
      // `shutdown()` (subscriber 1 each) → the primary clients THIS TEST
      // itself `connect()`-ed.
      if (ws) {
        await new Promise<void>((resolve) => {
          ws?.once('close', () => resolve());
          ws?.close();
        });
      }
      await Promise.all([stopRealServer(serverA), stopRealServer(serverB)]);
    }
  }, 20000);
});
