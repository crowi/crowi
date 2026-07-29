// Pin a stable WS_TOKEN_SECRET *before* `src/test/setup` boots the api —
// the presence token util captures the secret at construction time, and
// this file mints tokens directly via `createPresenceTokenUtil()` rather
// than through the HTTP endpoint. Matches the pattern in
// `hono/handlers/presence.test.ts` / `collab/attach.test.ts`.
process.env.WS_TOKEN_SECRET = process.env.WS_TOKEN_SECRET ?? 'test-ws-token-secret-base64-32bytes-=';

import { EventEmitter } from 'node:events';
import http from 'node:http';
import { AddressInfo } from 'node:net';
import type { PresenceViewer } from '@crowi/api-contract';
import { WS_CLOSE_CODES } from '@crowi/api-contract';
import { _setPresenceServiceForTesting, createPresenceService, type PresenceRedisClient, type PresenceService } from 'src/service/presence';
import { crowi } from 'src/test/setup';
import { createPageViaApi, createTestUser } from 'src/test/test-helpers';
import { createPresenceTokenUtil } from 'src/util/presence-token';
import { resolveRedisKeyspace } from 'src/util/redis-keyspace';
import WebSocket from 'ws';
import { type AttachedPresence, attachPresenceServer } from './attach';

/**
 * feature-presence-consistency-fixes — `presence/attach.ts` had no
 * dedicated test file before this task (its handler-level behaviour was
 * only exercised indirectly through `service/presence.test.ts` and the web
 * `use-presence.test.ts`). This file drives the real `ws` upgrade path
 * with a real `http.Server` — the same pattern `collab/attach.test.ts`
 * uses — to pin the 3 defects that live in `attach.ts` itself rather than
 * in `service/presence.ts`:
 *
 *   - defect 1 (multi-tab cross-replica dedup) — exercised end-to-end
 *     against TWO simulated replicas (two `attachPresenceServer` instances,
 *     each wired to its own `PresenceService` sharing one Redis-like
 *     backing store via `_setPresenceServiceForTesting`).
 *   - defect 2 (frame ordering / generation) — exercised with a
 *     controllable stand-in `PresenceService` whose `listViewers` resolves
 *     under test control, so the dispatch-vs-completion order can be
 *     inverted deterministically.
 *   - defect 4 (join failure closes the socket) — exercised with a
 *     stand-in whose `join` always throws.
 */

/** Minimal in-memory node-redis v4 stand-in — mirrors `service/presence.test.ts`'s `FakeRedis` fixture. */
class FakeRedis implements PresenceRedisClient {
  isOpen = true;
  private readonly hashes: Map<string, Map<string, string>>;
  private readonly subscribers: Map<string, Array<(message: string) => void>>;

  constructor(shared?: { hashes: Map<string, Map<string, string>>; subscribers: Map<string, Array<(message: string) => void>> }) {
    this.hashes = shared?.hashes ?? new Map();
    this.subscribers = shared?.subscribers ?? new Map();
  }

  private hash(key: string): Map<string, string> {
    let h = this.hashes.get(key);
    if (!h) {
      h = new Map();
      this.hashes.set(key, h);
    }
    return h;
  }

  async hSet(key: string, field: string, value: string): Promise<number> {
    const h = this.hash(key);
    const isNew = h.has(field) ? 0 : 1;
    h.set(field, value);
    return isNew;
  }

  async hGet(key: string, field: string): Promise<string | null | undefined> {
    return this.hashes.get(key)?.get(field) ?? null;
  }

  async hGetAll(key: string): Promise<Record<string, string>> {
    const h = this.hashes.get(key);
    if (!h) return {};
    return Object.fromEntries(h.entries());
  }

  async hDel(key: string, field: string | string[]): Promise<number> {
    const h = this.hashes.get(key);
    if (!h) return 0;
    const fields = Array.isArray(field) ? field : [field];
    let removed = 0;
    for (const f of fields) {
      if (h.delete(f)) removed += 1;
    }
    return removed;
  }

  async expire(): Promise<boolean> {
    return true;
  }

  async publish(channel: string, message: string): Promise<number> {
    const listeners = this.subscribers.get(channel) ?? [];
    for (const listener of listeners) {
      listener(message);
    }
    return listeners.length;
  }

  async subscribe(channel: string, listener: (message: string) => void): Promise<void> {
    const listeners = this.subscribers.get(channel) ?? [];
    listeners.push(listener);
    this.subscribers.set(channel, listeners);
  }

  duplicate(): PresenceRedisClient {
    return new FakeRedis({ hashes: this.hashes, subscribers: this.subscribers });
  }

  async connect(): Promise<unknown> {
    return undefined;
  }

  async disconnect(): Promise<unknown> {
    return undefined;
  }
}

interface TestServer {
  server: http.Server;
  port: number;
  attachment: AttachedPresence;
}

async function startTestServer(): Promise<TestServer> {
  const server = http.createServer();
  const attachment = await attachPresenceServer(server, crowi);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  return { server, port, attachment };
}

async function stopTestServer(s: TestServer): Promise<void> {
  try {
    await s.attachment.shutdown();
  } catch {
    // best-effort
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (s.server as any).closeAllConnections?.();
  await new Promise<void>((resolve) => {
    let resolved = false;
    const finish = (): void => {
      if (resolved) return;
      resolved = true;
      resolve();
    };
    const timer = setTimeout(finish, 1000);
    s.server.close(() => {
      clearTimeout(timer);
      finish();
    });
  });
}

/** A live WebSocket client plus every inbound JSON frame it has parsed so far. */
interface CapturedWs {
  ws: WebSocket;
  messages: Array<Record<string, unknown>>;
  closeCode: number | null;
}

function connectWs(url: string): CapturedWs {
  const ws = new WebSocket(url);
  const captured: CapturedWs = { ws, messages: [], closeCode: null };
  ws.on('message', (data: Buffer) => {
    try {
      captured.messages.push(JSON.parse(data.toString('utf8')));
    } catch {
      // ignore non-JSON frames
    }
  });
  ws.on('close', (code: number) => {
    captured.closeCode = code;
  });
  return captured;
}

function waitForOpen(ws: WebSocket, timeoutMs = 5000): Promise<void> {
  if (ws.readyState === ws.OPEN) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timed out waiting for the socket to open')), timeoutMs);
    ws.once('open', () => {
      clearTimeout(timer);
      resolve();
    });
    ws.once('error', (err: Error) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

async function waitUntil(predicate: () => boolean | Promise<boolean>, timeoutMs = 5000): Promise<void> {
  const start = Date.now();
  for (;;) {
    if (await predicate()) return;
    if (Date.now() - start > timeoutMs) throw new Error(`waitUntil timed out after ${timeoutMs}ms`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

describe('attachPresenceServer (feature-presence-consistency-fixes)', () => {
  const PATH_PREFIX = '/hono-presence-attach-test/';
  let accessToken: string;
  let userId: string;
  let pageId: string;

  beforeAll(async () => {
    const { user, accessToken: token } = await createTestUser({
      name: 'Presence Attach Tester',
      username: 'presenceAttachTester',
      email: 'presence-attach-tester@example.com',
    });
    accessToken = token;
    userId = user._id.toString();
    const page = await createPageViaApi(accessToken, `${PATH_PREFIX}basic`, '# presence attach test');
    pageId = page._id;
  });

  afterAll(async () => {
    const Page = crowi.model('Page');
    const Revision = crowi.model('Revision');
    const filter = { path: { $regex: `^${PATH_PREFIX}` } };
    await Promise.all([Page.deleteMany(filter), Revision.deleteMany(filter)]);
  });

  afterEach(() => {
    // Every test that injects a stand-in service resets the module-level
    // cache so it never leaks into a later test in this file.
    _setPresenceServiceForTesting(null);
  });

  function mintPresenceToken(): string {
    return createPresenceTokenUtil().signPresenceToken({ userId, pageId }).token;
  }

  describe('happy path (regression guard)', () => {
    it('joins, broadcasts a viewers frame carrying the connecting user and a generation, and leaves cleanly on close', async () => {
      // No `_setPresenceServiceForTesting` override — exercises the REAL
      // `getPresenceService(crowi)` wiring (in-process fallback, since the
      // test crowi has no Redis configured).
      const testServer = await startTestServer();
      try {
        const token = mintPresenceToken();
        const tab = connectWs(`ws://127.0.0.1:${testServer.port}/presence/${encodeURIComponent(pageId)}?token=${encodeURIComponent(token)}`);
        await waitForOpen(tab.ws);
        await waitUntil(() => tab.messages.some((m) => m.type === 'viewers'));

        const frame = tab.messages.find((m) => m.type === 'viewers') as { viewers: Array<{ userId: string }>; generation: number };
        expect(frame.viewers.map((v) => v.userId)).toEqual([userId]);
        expect(typeof frame.generation).toBe('number');

        tab.ws.close();
        await waitUntil(() => tab.closeCode !== null);
      } finally {
        await stopTestServer(testServer);
      }
    });
  });

  describe('multi-tab cross-replica dedup (defect 1, AC1)', () => {
    it('keeps the viewer present while ANY of their connections is open, even across replicas, and removes them once the LAST one closes', async () => {
      // Two simulated replicas: two independent `attachPresenceServer`
      // instances, each wired (via `_setPresenceServiceForTesting`) to its
      // OWN `PresenceService` — but both share the same underlying
      // `FakeRedis` backing store, exactly as two real api processes would
      // share one Redis.
      const sharedRedis = new FakeRedis();
      const keyspace = resolveRedisKeyspace(crowi);
      const serviceA = await createPresenceService(sharedRedis, keyspace);
      const serviceB = await createPresenceService(sharedRedis, keyspace);

      _setPresenceServiceForTesting(serviceA);
      const replicaA = await startTestServer();
      _setPresenceServiceForTesting(serviceB);
      const replicaB = await startTestServer();

      try {
        const token = mintPresenceToken();

        // Tab 1 connects to replica A.
        const tabA = connectWs(`ws://127.0.0.1:${replicaA.port}/presence/${encodeURIComponent(pageId)}?token=${encodeURIComponent(token)}`);
        await waitForOpen(tabA.ws);
        await waitUntil(() => tabA.messages.some((m) => m.type === 'viewers'));

        // Tab 2 (the SAME user, another tab) connects to replica B.
        const tabB = connectWs(`ws://127.0.0.1:${replicaB.port}/presence/${encodeURIComponent(pageId)}?token=${encodeURIComponent(token)}`);
        await waitForOpen(tabB.ws);
        await waitUntil(async () => (await serviceA.listViewers(pageId)).length === 1);

        // Sanity: the two tabs dedupe to a single viewer entry (both
        // replicas read the same shared Redis viewer hash).
        expect((await serviceA.listViewers(pageId)).map((v) => v.userId)).toEqual([userId]);
        expect((await serviceB.listViewers(pageId)).map((v) => v.userId)).toEqual([userId]);

        // Tab 1 (replica A) closes. The user must STILL be present — this
        // is the exact bug: the pre-fix local dedup check only ever saw
        // replica A's own connections, so it would incorrectly `leave` the
        // user out from under the still-open tab on replica B.
        tabA.ws.close();
        await waitUntil(() => tabA.closeCode !== null);
        // Give the server-side close handler a moment to run (async leave()).
        await new Promise((resolve) => setTimeout(resolve, 50));
        expect((await serviceA.listViewers(pageId)).map((v) => v.userId)).toEqual([userId]);
        expect((await serviceB.listViewers(pageId)).map((v) => v.userId)).toEqual([userId]);

        // The LAST remaining connection (tab 2, replica B) closes — the
        // user must now actually disappear from both replicas' view.
        tabB.ws.close();
        await waitUntil(() => tabB.closeCode !== null);
        await waitUntil(async () => (await serviceA.listViewers(pageId)).length === 0);
        expect(await serviceA.listViewers(pageId)).toEqual([]);
        expect(await serviceB.listViewers(pageId)).toEqual([]);
      } finally {
        await stopTestServer(replicaA);
        await stopTestServer(replicaB);
        await serviceA.shutdown();
        await serviceB.shutdown();
      }
    });
  });

  describe('viewers frame generation tracks dispatch order, not completion order (defect 2, AC2)', () => {
    it('numbers two overlapping broadcasts by DISPATCH order even when their listViewers reads resolve in reverse', async () => {
      // A controllable stand-in whose `listViewers` resolves only when the
      // test explicitly does so — lets the test invert completion order
      // relative to dispatch order deterministically.
      const emitter = new EventEmitter();
      const pendingResolvers: Array<(viewers: PresenceViewer[]) => void> = [];
      // Resolves once `openConnection` has actually called `presence.join()`
      // — which happens strictly AFTER it registers the socket in its own
      // `connections` map (see `attach.ts`), so awaiting this is a
      // deterministic readiness gate: the test's own `publish()` calls
      // below must not race the connection's own registration (the
      // transport-level 'open' event on the CLIENT can fire before the
      // server's async `authenticate()` + `openConnection()` finish).
      let signalJoinCalled!: () => void;
      const joinCalled = new Promise<void>((resolve) => {
        signalJoinCalled = resolve;
      });
      const controllableService: PresenceService = {
        async join() {
          // No broadcast of its own in this test — only the explicit
          // `controllableService.publish('viewers', ...)` calls below
          // should drive the feed handler.
          signalJoinCalled();
        },
        async heartbeat() {
          return true;
        },
        async leave() {},
        listViewers() {
          return new Promise<PresenceViewer[]>((resolve) => {
            pendingResolvers.push(resolve);
          });
        },
        async markEditing() {},
        async refreshEditing() {},
        async unmarkEditing() {},
        async publishPageUpdated() {},
        async publishCommentChanged() {},
        subscribe(feed, listener) {
          emitter.on(feed, listener);
          return () => emitter.off(feed, listener);
        },
        async publish(feed, publishedPageId, payload) {
          emitter.emit(feed, publishedPageId, payload);
        },
        async shutdown() {},
      };
      _setPresenceServiceForTesting(controllableService);
      const testServer = await startTestServer();

      try {
        const token = mintPresenceToken();
        const tab = connectWs(`ws://127.0.0.1:${testServer.port}/presence/${encodeURIComponent(pageId)}?token=${encodeURIComponent(token)}`);
        await waitForOpen(tab.ws);
        await joinCalled;

        // Two broadcasts dispatched back-to-back — simulating a join event
        // and a leave event racing (spec's motivating scenario). Both
        // `listViewers` reads are now in flight, each with its own
        // resolver captured in `pendingResolvers`, in DISPATCH order.
        await controllableService.publish('viewers', pageId);
        await controllableService.publish('viewers', pageId);
        await waitUntil(() => pendingResolvers.length === 2);

        // Resolve them in REVERSE order: the broadcast dispatched SECOND
        // (higher generation) completes FIRST.
        pendingResolvers[1]([]);
        await waitUntil(() => tab.messages.length === 1);
        pendingResolvers[0]([{ userId: 'stale-viewer', username: 'stale', displayName: 'Stale Viewer', avatarUrl: null, isEditing: false, joinedAt: 1 }]);
        await waitUntil(() => tab.messages.length === 2);

        const [arrivedFirst, arrivedSecond] = tab.messages as Array<{ generation: number }>;
        // The frame that arrived FIRST was dispatched SECOND — it carries
        // the HIGHER generation. The frame that arrived SECOND (late) was
        // dispatched FIRST — it carries the LOWER generation. This is the
        // signal a client uses to discard a stale, out-of-order frame
        // instead of rendering whichever one merely arrived last.
        expect(arrivedFirst.generation).toBe(2);
        expect(arrivedSecond.generation).toBe(1);
        expect(arrivedSecond.generation).toBeLessThan(arrivedFirst.generation);
      } finally {
        await stopTestServer(testServer);
      }
    });
  });

  describe('per-page generation counter is dropped once no local connection watches the page (advisory: unbounded growth)', () => {
    it('restarts the generation count from 1 for a page once every local connection to it has closed', async () => {
      const testServer = await startTestServer();
      try {
        const token = mintPresenceToken();

        // First tab joins — the counter for `pageId` is created and
        // advances to 1.
        const firstTab = connectWs(`ws://127.0.0.1:${testServer.port}/presence/${encodeURIComponent(pageId)}?token=${encodeURIComponent(token)}`);
        await waitForOpen(firstTab.ws);
        await waitUntil(() => firstTab.messages.some((m) => m.type === 'viewers'));
        const firstFrame = firstTab.messages.find((m) => m.type === 'viewers') as { generation: number };
        expect(firstFrame.generation).toBe(1);

        // It closes — this was the ONLY local connection on `pageId`, so
        // `handleClose` must drop the page's counter entry entirely
        // rather than merely leaving it parked at 1.
        firstTab.ws.close();
        await waitUntil(() => firstTab.closeCode !== null);

        // A second, independent tab joins the SAME page. If the counter
        // had not been dropped, this join's broadcast would be numbered
        // 2 (continuing the old lineage); since it was dropped, the
        // count restarts at 1 — proving the map entry no longer lingers.
        const secondTab = connectWs(`ws://127.0.0.1:${testServer.port}/presence/${encodeURIComponent(pageId)}?token=${encodeURIComponent(token)}`);
        await waitForOpen(secondTab.ws);
        await waitUntil(() => secondTab.messages.some((m) => m.type === 'viewers'));
        const secondFrame = secondTab.messages.find((m) => m.type === 'viewers') as { generation: number };
        expect(secondFrame.generation).toBe(1);

        secondTab.ws.close();
        await waitUntil(() => secondTab.closeCode !== null);
      } finally {
        await stopTestServer(testServer);
      }
    });
  });

  describe('presence.join() failure closes the socket (defect 4, AC4)', () => {
    it('closes the connection with the shared internal-error close code instead of leaving it open unregistered', async () => {
      const failingService: PresenceService = {
        async join() {
          throw new Error('boom — simulated Redis outage');
        },
        async heartbeat() {
          return true;
        },
        async leave() {},
        async listViewers() {
          return [];
        },
        async markEditing() {},
        async refreshEditing() {},
        async unmarkEditing() {},
        async publishPageUpdated() {},
        async publishCommentChanged() {},
        subscribe() {
          return () => {};
        },
        async publish() {},
        async shutdown() {},
      };
      _setPresenceServiceForTesting(failingService);
      const testServer = await startTestServer();

      try {
        const token = mintPresenceToken();
        const tab = connectWs(`ws://127.0.0.1:${testServer.port}/presence/${encodeURIComponent(pageId)}?token=${encodeURIComponent(token)}`);
        await waitForOpen(tab.ws);
        await waitUntil(() => tab.closeCode !== null);

        expect(tab.closeCode).toBe(WS_CLOSE_CODES.INTERNAL_ERROR);
        // No `viewers` frame was ever sent — the connection never
        // actually registered, so the client's existing reconnect logic
        // (rather than a silently-stale open socket) is the only path
        // back to a working viewer list.
        expect(tab.messages).toEqual([]);
      } finally {
        await stopTestServer(testServer);
      }
    });

    it('also closes the connection when the HEARTBEAT-triggered re-join fails (the socket is not left open unregistered forever)', async () => {
      // `handleClientMessage`'s heartbeat branch re-joins when
      // `presence.heartbeat()` reports the entry was swept. That
      // re-join is a second, independent `presence.join()` call site
      // from the initial-connect one covered by the test above — this
      // pins that it fails closed the same way, not silently (the
      // regression this test would have caught: the heartbeat branch's
      // `catch` only logged via `debug()` and returned, leaving the
      // socket open with no viewers frame ever arriving and no future
      // heartbeat able to recover it).
      // Mirrors the "controllable stand-in" pattern from the defect-2
      // describe block above: a real `EventEmitter` behind `subscribe`/
      // `publish` so a successful `join()` can actually drive a `viewers`
      // frame back to the client (the earlier, always-throws defect-4
      // test never needs this — it never reaches a successful join).
      const emitter = new EventEmitter();
      let joinCalls = 0;
      const sweptThenFailingService: PresenceService = {
        async join(pageIdArg) {
          joinCalls += 1;
          if (joinCalls === 1) {
            emitter.emit('viewers', pageIdArg); // initial connect succeeds and broadcasts
            return;
          }
          throw new Error('boom — simulated Redis outage on re-join');
        },
        async heartbeat() {
          return false; // pretend the entry was swept — forces the re-join branch
        },
        async leave() {},
        async listViewers() {
          return [];
        },
        async markEditing() {},
        async refreshEditing() {},
        async unmarkEditing() {},
        async publishPageUpdated() {},
        async publishCommentChanged() {},
        subscribe(feed, listener) {
          emitter.on(feed, listener);
          return () => emitter.off(feed, listener);
        },
        async publish(feed, publishedPageId, payload) {
          emitter.emit(feed, publishedPageId, payload);
        },
        async shutdown() {},
      };
      _setPresenceServiceForTesting(sweptThenFailingService);
      const testServer = await startTestServer();

      try {
        const token = mintPresenceToken();
        const tab = connectWs(`ws://127.0.0.1:${testServer.port}/presence/${encodeURIComponent(pageId)}?token=${encodeURIComponent(token)}`);
        await waitForOpen(tab.ws);
        await waitUntil(() => tab.messages.some((m) => m.type === 'viewers'));

        tab.ws.send(JSON.stringify({ type: 'heartbeat' }));
        await waitUntil(() => tab.closeCode !== null);

        expect(tab.closeCode).toBe(WS_CLOSE_CODES.INTERNAL_ERROR);
        expect(joinCalls).toBe(2);
      } finally {
        await stopTestServer(testServer);
      }
    });
  });
});
