/**
 * feature-redis-8-upgrade Phase 2 — collab pub/sub smoke (consumer #1,
 * required). Real Redis 8 end-to-end: `buildCollabRedisExtension()`
 * (unmodified production code) wired into a real `Hocuspocus` engine,
 * driven from two INDEPENDENT OS processes (`redis-smoke-harness.ts`, run
 * via `tsx` — see that file's doc comment for why bare Jest can't construct
 * a real `Hocuspocus` at all). This test spawns both, connects a real
 * `HocuspocusProvider` (the same client class `@crowi/web` uses in
 * production) to each, and asserts:
 *   - a Y.Doc text edit on instance A propagates to instance B's Y.Doc via
 *     the Redis extension's pub/sub relay, and
 *   - `Awareness` local state set on either side propagates to the other
 *     (bidirectional).
 *
 * Deliberately uses real `ws.WebSocket` connections end to end (never
 * `openDirectConnection()`) — `document.connections` must be populated for
 * the extension's own `onAwarenessUpdate` hook to publish at all (see
 * `redis-smoke-harness.ts`'s doc comment).
 */
import { HocuspocusProvider } from '@hocuspocus/provider';
import { markRedisSmokeRan, REDIS_SMOKE_URLS, redisSmokeReachable, uniqueRedisSmokeId } from 'src/test/redis-smoke';
import WsWebSocket from 'ws';
import type { Awareness } from 'y-protocols/awareness';
import * as Y from 'yjs';
import { type RedisSmokeHarness as Harness, spawnRedisSmokeHarness as spawnHarness, stopRedisSmokeHarness as stopHarness } from './redis-smoke-harness-client';

const describeMaybe = redisSmokeReachable.shared ? describe : describe.skip;

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), timeoutMs);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

function waitForSynced(provider: HocuspocusProvider): Promise<void> {
  return new Promise((resolve) => {
    provider.on('synced', ({ state }: { state: boolean }) => {
      if (state) resolve();
    });
  });
}

function waitForAwarenessField(awareness: Awareness, key: string, expectedValue: unknown): Promise<void> {
  return new Promise((resolve) => {
    const check = (): boolean => {
      for (const state of awareness.getStates().values()) {
        if (state && typeof state === 'object' && (state as Record<string, unknown>)[key] === expectedValue) {
          awareness.off('change', check);
          resolve();
          return true;
        }
      }
      return false;
    };
    if (check()) return;
    awareness.on('change', check);
  });
}

describeMaybe('collab pub/sub smoke (real Redis 8, 2-process harness)', () => {
  beforeAll(() => {
    markRedisSmokeRan('collab');
  });

  it('propagates a Y.Doc text change and bidirectional Awareness state between two independent Hocuspocus instances via the Redis extension', async () => {
    const documentName = uniqueRedisSmokeId('collab-doc');
    // Spawn both harnesses concurrently (independent tsx child boots,
    // ~1-3s each). allSettled + the explicit partial-failure sweep keeps a
    // single teardown path: whichever spawn succeeded is stopped before a
    // failure propagates.
    const spawns = await Promise.allSettled([spawnHarness('A', REDIS_SMOKE_URLS.shared), spawnHarness('B', REDIS_SMOKE_URLS.shared)]);
    const spawned = spawns.filter((r): r is PromiseFulfilledResult<Harness> => r.status === 'fulfilled').map((r) => r.value);
    const failed = spawns.find((r): r is PromiseRejectedResult => r.status === 'rejected');
    if (failed) {
      await Promise.all(spawned.map(stopHarness));
      throw failed.reason;
    }
    const [harnessA, harnessB] = spawned;

    const docA = new Y.Doc();
    const docB = new Y.Doc();
    let providerA: HocuspocusProvider | null = null;
    let providerB: HocuspocusProvider | null = null;

    try {
      providerA = new HocuspocusProvider({
        url: `ws://127.0.0.1:${harnessA.port}`,
        name: documentName,
        document: docA,
        token: 'smoke-token',
        // Node has no ambient `WebSocket` global under jest's Node test
        // environment (no jsdom) on every supported Node version — pass
        // the `ws` implementation explicitly (already a direct
        // `@crowi/api` dependency, the same one `attach.ts` uses
        // server-side) rather than relying on the runtime's own global.
        WebSocketPolyfill: WsWebSocket as unknown as typeof WebSocket,
      });
      providerB = new HocuspocusProvider({
        url: `ws://127.0.0.1:${harnessB.port}`,
        name: documentName,
        document: docB,
        token: 'smoke-token',
        WebSocketPolyfill: WsWebSocket as unknown as typeof WebSocket,
      });

      await withTimeout(
        Promise.all([waitForSynced(providerA), waitForSynced(providerB)]),
        15000,
        'initial sync did not complete for both providers within 15s',
      );

      // --- Y.Doc sync: A writes, B observes the change relayed through Redis ---
      const marker = `hello-from-A-${documentName}`;
      const textA = docA.getText('content');
      const textB = docB.getText('content');
      const receivedOnB = new Promise<void>((resolve) => {
        const observer = (): void => {
          if (textB.toString().includes(marker)) {
            textB.unobserve(observer);
            resolve();
          }
        };
        textB.observe(observer);
      });
      textA.insert(0, marker);
      await withTimeout(receivedOnB, 10000, 'Y.Doc update did not propagate from instance A to instance B via the Redis pub/sub relay');
      expect(textB.toString()).toContain(marker);

      // --- Awareness: bidirectional propagation ---
      const awarenessA = providerA.awareness as Awareness;
      const awarenessB = providerB.awareness as Awareness;
      expect(awarenessA).toBeTruthy();
      expect(awarenessB).toBeTruthy();

      const bSeesA = waitForAwarenessField(awarenessB, 'smokeLabel', 'from-A');
      awarenessA.setLocalStateField('smokeLabel', 'from-A');
      await withTimeout(bSeesA, 10000, 'awareness state set on instance A did not reach instance B');

      const aSeesB = waitForAwarenessField(awarenessA, 'smokeLabel', 'from-B');
      awarenessB.setLocalStateField('smokeLabel', 'from-B');
      await withTimeout(aSeesB, 10000, 'awareness state set on instance B did not reach instance A');
    } finally {
      // Ownership-aware teardown: the providers' own WebSocket + the
      // Y.Docs are ours to close; the harness PROCESSES own their
      // Hocuspocus instance + the extension's ioredis pub/sub clients.
      // `stopHarness` sends SIGTERM, and each harness's own graceful
      // shutdown handler runs the Hocuspocus `onDestroy` hook chain (which
      // disconnects the extension's `pub`/`sub` clients) before exiting —
      // see `redis-smoke-harness.ts`'s doc comment.
      providerA?.destroy();
      providerB?.destroy();
      docA.destroy();
      docB.destroy();
      await Promise.all([stopHarness(harnessA), stopHarness(harnessB)]);
    }
  }, 60000);
});
