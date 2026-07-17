// Pin a stable WS_TOKEN_SECRET *before* the api boot reads it so the
// HTTP-issued tokens and the in-process Hocuspocus verify path share
// the same secret — matches the pattern in `routes/ts-rest/page-collab.test.ts`.
process.env.WS_TOKEN_SECRET = process.env.WS_TOKEN_SECRET ?? 'test-ws-token-secret-base64-32bytes-=';

/**
 * Mock the real `@crowi/collab` runtime because its transitive
 * dependency `crossws/adapters/node.mjs` is ESM-only and Jest's CJS
 * loader can't parse it. The hook + save-flow coverage that would
 * normally exercise Hocuspocus's protocol lives in
 * `packages/collab/src/__tests__/` (which doesn't import the heavy
 * `Server` / `Hocuspocus` runtime, only the type-erased hook
 * factories) — here we focus on the api-side wiring:
 *   - `/collab/*` path filter routes the upgrade into `wss.handleUpgrade`
 *   - non-`/collab/*` paths fall through (other upgrade handlers still see them)
 *   - the `shutdown` handle removes the listener and is idempotent
 *
 * Replacing `createCollabServer` with a stub `Hocuspocus`-shaped
 * object lets us assert the upgrade actually reached our code path
 * (the stub records `handleConnection` calls).
 */
let lastFakeHocuspocus: FakeHocuspocus | null = null;
let lastCreateCalls: number = 0;
// Capture the args `createCollabServer` was last invoked with so the
// Phase 9 extensions wiring can be asserted (the test runs with
// `crowi.redis === null`, so we expect an empty `extensions` array).
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let lastCreateOpts: any = null;

interface FakeHocuspocus {
  handleConnection: jest.Mock;
  flushPendingStores: jest.Mock;
  closeConnections: jest.Mock;
}

jest.mock('@crowi/collab', () => ({
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  createCollabServer: jest.fn((opts: any) => {
    lastCreateCalls += 1;
    lastCreateOpts = opts;
    const fake: FakeHocuspocus = {
      handleConnection: jest.fn(() => ({
        handleMessage: jest.fn(),
        handleClose: jest.fn(),
      })),
      flushPendingStores: jest.fn(),
      closeConnections: jest.fn(),
    };
    lastFakeHocuspocus = fake;
    // G1 — `createCollabServer` now returns the engine PLUS the
    // external-edit invalidator bound to it.
    return { hocuspocus: fake, invalidator: { invalidatePages: jest.fn(async () => undefined) } };
  }),
}));

import http from 'node:http';
import { AddressInfo } from 'node:net';
import WebSocket from 'ws';
import { crowi } from 'src/test/setup';
import { attachCollabServer, type AttachedCollab } from './attach';

interface TestServer {
  server: http.Server;
  port: number;
  attachment: AttachedCollab;
}

async function startTestServer(): Promise<TestServer> {
  // RFC-0006 Phase 6 Sub-batch D — Express is gone; the test only
  // needs an http.Server that the WS upgrade handler can attach to.
  // We use the bare `http.createServer()` with no request listener:
  // the WebSocket smoke test never issues an HTTP request, so a
  // request listener would be dead weight.
  const server = http.createServer();
  const attachment = await attachCollabServer(server, crowi);
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
  // `server.close()` waits for in-flight connections to finish — the
  // mock Hocuspocus never closes its peers, so we force the server
  // to drop them with `closeAllConnections()` (Node 18.2+).
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (s.server as any).closeAllConnections?.();
  await new Promise<void>((resolve) => {
    let resolved = false;
    const finish = (): void => {
      if (resolved) return;
      resolved = true;
      resolve();
    };
    // Last-resort safety net so a stray client socket can't hang the
    // test runner. If `close()` doesn't call back within 1s, just
    // give up — the test process will exit anyway and the OS GCs.
    const timer = setTimeout(finish, 1000);
    s.server.close(() => {
      clearTimeout(timer);
      finish();
    });
  });
}

interface WsOutcome {
  opened: boolean;
  closeCode?: number;
}

/**
 * Open a WebSocket and resolve with the result observed within
 * `timeoutMs`. The fake Hocuspocus accepts the upgrade
 * unconditionally (its `handleConnection` is a no-op), so a
 * successful `open` event means the upgrade made it through our
 * `'upgrade'` handler.
 */
function probeWs(url: string, timeoutMs = 1000): Promise<WsOutcome> {
  return new Promise((resolve) => {
    const result: WsOutcome = { opened: false };
    const ws = new WebSocket(url);
    let settled = false;
    const settle = (): void => {
      if (settled) return;
      settled = true;
      try {
        ws.close();
      } catch {
        // ignore
      }
      resolve(result);
    };
    ws.on('open', () => {
      result.opened = true;
      setTimeout(settle, 50);
    });
    ws.on('close', (code: number) => {
      result.closeCode = code;
      settle();
    });
    ws.on('error', () => {
      // Let `close` settle.
    });
    setTimeout(settle, timeoutMs);
  });
}

describe('attachCollabServer (RFC-0003 Phase 9 same-process attach)', () => {
  let testServer: TestServer;

  beforeAll(async () => {
    testServer = await startTestServer();
  }, 15000);

  afterAll(async () => {
    await stopTestServer(testServer);
  }, 15000);

  it('builds the Hocuspocus engine exactly once per attach call', () => {
    // beforeAll ran `attachCollabServer` once; the mock counter must
    // reflect a single call (= the engine is process-singleton from
    // the api's perspective).
    expect(lastCreateCalls).toBeGreaterThanOrEqual(1);
    expect(lastFakeHocuspocus).not.toBeNull();
  });

  it('passes an empty extensions array to createCollabServer when crowi.redis is null', () => {
    // Phase 9 contract: with no Redis wired (test fixture sets
    // `crowi.redis = null`), the Redis extension MUST NOT be
    // constructed. The collab engine still runs — just in single-
    // instance mode — and Hocuspocus's own `extensions: []` default
    // applies inside.
    expect(crowi.redis).toBeNull();
    expect(lastCreateOpts).not.toBeNull();
    expect(Array.isArray(lastCreateOpts.extensions)).toBe(true);
    expect(lastCreateOpts.extensions).toHaveLength(0);
  });

  it('routes /collab/<pageId> upgrades into the Hocuspocus engine', async () => {
    const baseline = lastFakeHocuspocus?.handleConnection.mock.calls.length ?? 0;
    const url = `ws://127.0.0.1:${testServer.port}/collab/fake-page-id?token=ignored`;
    // Generous ceiling: `probeWs` resolves the instant the `open` event
    // fires, so a longer timeout never slows the happy path — it only
    // stops a loaded CI runner (where the WS handshake can take >1s)
    // from giving up early and reporting a false `opened: false`.
    const outcome = await probeWs(url, 10000);
    // Upgrade reached our handler → wss.handleUpgrade accepted →
    // wireConnection called hocuspocus.handleConnection on the
    // (stub) engine. Open is observed at the ws client.
    expect(outcome.opened).toBe(true);
    expect(lastFakeHocuspocus?.handleConnection.mock.calls.length ?? 0).toBeGreaterThan(baseline);
  });

  it('does NOT upgrade when the path is not under /collab/', async () => {
    const baseline = lastFakeHocuspocus?.handleConnection.mock.calls.length ?? 0;
    const url = `ws://127.0.0.1:${testServer.port}/some/other/path`;
    // 1500ms budget: this is a negative probe (we assert `opened === false`),
    // so the timeout is only reached when the upgrade is correctly rejected
    // and `open` never fires. A 500ms ceiling was too tight under parallel
    // load — a successful handshake that takes >500ms would settle the probe
    // via timeout with `opened` still false, producing a false negative.
    // The happy path resolves on `open` instantly, so a higher ceiling adds
    // no cost; it only stops a loaded CI runner from racing the open event.
    const outcome = await probeWs(url, 1500);
    // No other upgrade handler is registered on the test server, so
    // the client times out without `open` ever firing.
    expect(outcome.opened).toBe(false);
    // And our Hocuspocus engine was not invoked.
    expect(lastFakeHocuspocus?.handleConnection.mock.calls.length ?? 0).toBe(baseline);
  });

  it('shutdown calls flushPendingStores + closeConnections (per still-connected socket) and is idempotent', async () => {
    const fake = lastFakeHocuspocus;
    expect(fake).not.toBeNull();
    const flushBefore = fake?.flushPendingStores.mock.calls.length ?? 0;
    const closeBefore = fake?.closeConnections.mock.calls.length ?? 0;

    // `attachWsNamespace`'s `politeClose` is invoked once per socket the
    // primitive is still tracking at shutdown time (never when there
    // are zero live connections) — every earlier probe in this
    // describe block already closed its own socket, so a fresh one is
    // opened and kept alive through the call below.
    const client = new WebSocket(`ws://127.0.0.1:${testServer.port}/collab/shutdown-probe?token=ignored`);
    await new Promise<void>((resolve) => client.on('open', () => resolve()));

    // Call shutdown on the shared `testServer.attachment` — this is
    // safe to do twice because the contract is idempotent, and
    // `afterAll` will call it again after the assertion. The
    // upgrade listener is removed on the first call so subsequent
    // tests in this describe block don't observe stale state (none
    // exist, but the invariant is documented for future additions).
    await testServer.attachment.shutdown();
    expect(fake?.flushPendingStores.mock.calls.length).toBeGreaterThan(flushBefore);
    expect(fake?.closeConnections.mock.calls.length).toBeGreaterThan(closeBefore);

    client.terminate();

    // Second call — must be a safe no-op (idempotent contract).
    await expect(testServer.attachment.shutdown()).resolves.toBeUndefined();
  });
});
