/**
 * feature-redis-8-upgrade Phase 2 — collab pub/sub smoke harness (consumer
 * #1, required).
 *
 * A real `Hocuspocus` engine, wired to the REAL `buildCollabRedisExtension()`
 * (unmodified production code, `./extension-redis.ts`) so this is the exact
 * Redis extension configuration `attachCollabServer` builds — plus a real
 * `http.Server` + `ws` `noServer` upgrade, mirroring `attach.ts`'s own
 * wiring. Deliberately does NOT go through `createCollabServer` /
 * `@crowi/collab`'s save-flow hooks (`onLoadDocument` / `onStoreDocument` /
 * `onChange`, which need real `Page`/`Revision` Mongo documents): the Y.Doc
 * sync + awareness fan-out this smoke verifies is entirely
 * `@hocuspocus/extension-redis`'s own `onChange` / `onAwarenessUpdate` hooks
 * relaying through Redis — a bare `Hocuspocus` instance (no custom
 * `onLoadDocument`, so each side starts from an empty Y.Doc) exercises that
 * exact mechanism. The upstream extension's Redlock-based store-lock
 * acquire/release is deliberately NOT exercised here (see the spec's "やら
 * ないこと" — CI verification of that would need a full TLS+ACL edit→save
 * cycle through the save flow, which round 2-3 of the design repeatedly
 * broke).
 *
 * Run OUTSIDE Jest's CJS process, via `tsx` (ESM-capable) — see the spec's
 * "共同編集 smoke テスト" section for why: `@hocuspocus/server`'s CJS build
 * `require()`s `crossws/adapters/node`, whose `./adapters/node` export is
 * ESM-only, which Jest's `ts-jest` CJS transform cannot parse (the same
 * constraint `collab/attach.test.ts` documents for why it mocks
 * `@crowi/collab` wholesale). Two of these run as independent OS processes
 * (`redis-smoke-harness.test... ` spawns them via `child_process`) so
 * `process.pid` differs naturally between them — `buildCollabRedisExtension`'s
 * `identifier` derivation is untouched (per the spec's "やらないこと":
 * no identifier/seam changes to production code).
 *
 * Also reused, single-instance, by the boot/TLS smoke (consumer #8,
 * `crowi/index.smoke.test.ts`) to verify the collab-side ioredis client
 * completes a real TLS handshake against the `rediss://` fixture — that
 * test spawns ONE of these harnesses pointed at the TLS target (via the
 * shared `spawnRedisSmokeHarness` client helper, `./redis-smoke-harness-client.ts`)
 * and treats reaching "ready" as the pass signal, since this file's own
 * startup sequence already forces (and asserts) a real connect+PING on the
 * extension's `pub` client before signaling ready (see below) — that self
 * check is what actually proves the TLS handshake succeeds, not just that
 * `buildCollabRedisExtension()` returned a non-null object.
 *
 * Control protocol (deliberately minimal — the spec leaves the exact shape
 * to implementation):
 *   - Required env: `CROWI_REDIS_SMOKE_REDIS_URL` (the Redis target both
 *     harness processes must share so their extensions relay through the
 *     same pub/sub channel).
 *   - Optional env: `CROWI_REDIS_SMOKE_LABEL` (cosmetic, for log lines).
 *   - Optional env: `REDIS_REJECT_UNAUTHORIZED` (forwarded to
 *     `buildCollabRedisExtension`'s internal `parseRedisUrlForIoredis` call,
 *     same as the api's primary client — set to `'0'` by the boot/TLS
 *     smoke's harness spawn since the TLS fixture is self-signed).
 *   - On successful listen, emits exactly ONE JSON line on stdout:
 *     `{"ready":true,"port":<number>,"pid":<number>}` — the parent (Jest)
 *     process reads stdout line-by-line and resolves once it sees this.
 *   - `documentName` is NOT a harness concern: it travels through the
 *     Hocuspocus wire protocol itself (the client — `HocuspocusProvider` in
 *     the Jest test — supplies it), not the harness's own HTTP/WS wiring.
 *     Both test clients simply point at the SAME `documentName` when they
 *     construct their two `HocuspocusProvider`s.
 *   - Graceful shutdown on `SIGTERM`: closes the WS server, then the HTTP
 *     server, then runs the Hocuspocus `onDestroy` hook chain (which tears
 *     down the Redis extension's own `pub`/`sub` ioredis clients — see the
 *     `shutdown` function below), then exits 0. The parent's
 *     `child_process` teardown sends this signal and waits for the `exit`
 *     event.
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import type Crowi from 'src/crowi';
import { WebSocketServer, type WebSocket as WsWebSocket } from 'ws';
import { Hocuspocus } from '@hocuspocus/server';
import { buildCollabRedisExtension } from './extension-redis';

function log(message: string): void {
  const label = process.env.CROWI_REDIS_SMOKE_LABEL ?? 'harness';
  // stderr, not stdout — stdout is reserved for the single ready-notification
  // JSON line the parent process parses.
  process.stderr.write(`[redis-smoke-harness:${label}] ${message}\n`);
}

async function main(): Promise<void> {
  const redisUrl = process.env.CROWI_REDIS_SMOKE_REDIS_URL;
  if (!redisUrl) {
    throw new Error('redis-smoke-harness: CROWI_REDIS_SMOKE_REDIS_URL env var is required');
  }

  // Minimal Crowi-shaped stub. `buildCollabRedisExtension` reads `.redis` (a
  // null-check gate — never calls a method on it, the extension opens its
  // OWN ioredis pub/sub clients via its `createClient` callback), `.redisUrl`
  // (parsed into ioredis connect options), and now also `.getBaseUrl()` /
  // `.getEnv()` (feature-redis-key-prefix §1/§2 — `resolveRedisKeyspace()`
  // resolves the extension's `prefix` from these). A fixed `CLIENT_URL`
  // is enough here: every harness process spawned by
  // `redis-smoke-harness-client.ts` for a given test shares it, matching
  // "replicas of the same site" (the multi-process smoke tests assert that
  // two such harnesses DO relay pub/sub to each other). Same
  // cast-through-`unknown` pattern `extension-redis.test.ts` / `attach.test.ts`
  // use for a narrow Crowi-shaped fixture.
  const fakeCrowi = {
    redis: {},
    redisUrl,
    getBaseUrl: () => 'https://collab-redis-smoke.example.com',
    getEnv: () => ({}) as NodeJS.ProcessEnv,
  } as unknown as Crowi;
  const redisExtension = buildCollabRedisExtension(fakeCrowi);
  if (!redisExtension) {
    // Unreachable in practice (redisUrl is always provided above), but fail
    // loud rather than silently running in single-instance mode — a smoke
    // test that "passes" without the extension attached would prove nothing.
    throw new Error('redis-smoke-harness: buildCollabRedisExtension returned null despite a redisUrl being provided');
  }

  // Eager connectivity self-check on the extension's OWN `pub` client
  // (`lazyConnect: true` means `buildCollabRedisExtension` alone doesn't
  // open a socket) — forces the real TLS/plaintext handshake to happen now,
  // before the ready signal below, instead of only implicitly on first use.
  // This is also what lets `crowi/index.smoke.test.ts` (consumer #8) verify
  // the collab-side ioredis client against the `rediss://` fixture purely by
  // spawning a harness process and observing whether it reaches "ready" —
  // without ever constructing `buildCollabRedisExtension()` inside Jest's
  // CJS process itself (impossible; see this file's top doc comment).
  const { pub } = redisExtension as unknown as { pub: { connect: () => Promise<unknown>; ping: () => Promise<string> } };
  await pub.connect();
  const pong = await pub.ping();
  if (pong !== 'PONG') {
    throw new Error(`redis-smoke-harness: unexpected PING reply from the extension's pub client: ${pong}`);
  }
  log(`extension pub client connected and PONGed (redis=${redisUrl})`);

  const hocuspocus = new Hocuspocus({
    // No onAuthenticate / onLoadDocument / onStoreDocument overrides — a
    // bare engine accepts every connection (Hocuspocus's own "onAuthenticate
    // only if required" default) and starts each document from an empty
    // Y.Doc. That is sufficient: the sync + awareness relay this smoke
    // exercises is entirely the Redis extension's own `onChange` /
    // `onAwarenessUpdate` hooks, layered onto the engine via `extensions`
    // below — the same mechanism `attachCollabServer` wires in production,
    // independent of the save-flow hooks `createCollabServer` also adds.
    extensions: [redisExtension],
    debounce: 50,
    maxDebounce: 200,
  });

  const httpServer = http.createServer();
  const wss = new WebSocketServer({ noServer: true });

  httpServer.on('upgrade', (request, socket, head) => {
    wss.handleUpgrade(request, socket, head, (ws: WsWebSocket) => {
      // Same wiring as `collab/attach.ts`'s `onOpen` — real WebSocket
      // connection handed to Hocuspocus so it registers in
      // `document.connections` (required for the extension's
      // `onAwarenessUpdate` connections.size gate, and the reason this
      // smoke does NOT use `openDirectConnection()`).
      const clientConnection = hocuspocus.handleConnection(ws as never, request as never);
      ws.on('message', (data: Buffer | ArrayBuffer) => {
        const view: Uint8Array = data instanceof ArrayBuffer ? new Uint8Array(data) : data;
        clientConnection.handleMessage(view);
      });
      ws.on('close', (code: number, reason: Buffer) => {
        clientConnection.handleClose({ code, reason: reason?.toString?.() ?? '' });
      });
    });
  });

  await new Promise<void>((resolve) => httpServer.listen(0, '127.0.0.1', resolve));
  const port = (httpServer.address() as AddressInfo).port;
  log(`listening on 127.0.0.1:${port} (redis=${redisUrl})`);

  // Single JSON line on stdout — the parent's ready-notification protocol.
  process.stdout.write(`${JSON.stringify({ ready: true, port, pid: process.pid })}\n`);

  let shuttingDown = false;
  const shutdown = async (): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    log('shutting down');
    try {
      wss.close();
    } catch (err) {
      log(`wss.close failed: ${(err as Error).message}`);
    }
    await new Promise<void>((resolve) => httpServer.close(() => resolve()));
    // Explicit extension teardown — the same `onDestroy` hook invocation
    // `@hocuspocus/server`'s own `Server.destroy()` runs (see that class's
    // `destroy()` in `hocuspocus-server.esm.js`), calling
    // `buildCollabRedisExtension`'s `@hocuspocus/extension-redis` instance's
    // `onDestroy()`, which disconnects both its `pub`/`sub` ioredis clients.
    // Relying on process exit alone to reclaim those sockets would work in
    // practice but isn't the extension's OWN teardown path — this harness
    // constructs a bare `Hocuspocus` core (no wrapping `Server`), so nothing
    // else calls `hooks('onDestroy', ...)` for it.
    try {
      await hocuspocus.hooks('onDestroy', { instance: hocuspocus });
    } catch (err) {
      log(`hocuspocus onDestroy hook failed: ${(err as Error).message}`);
    }
    process.exit(0);
  };

  process.on('SIGTERM', () => {
    void shutdown();
  });
  process.on('SIGINT', () => {
    void shutdown();
  });
}

main().catch((err: unknown) => {
  process.stderr.write(`redis-smoke-harness fatal: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`);
  process.exit(1);
});
