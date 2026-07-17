import type { IncomingMessage } from 'node:http';
import http from 'node:http';
import { AddressInfo } from 'node:net';
import WebSocket, { WebSocketServer } from 'ws';
import { attachWsNamespace } from './attach-namespace';

/**
 * Tests for the `attachWsNamespace` primitive extracted from
 * `collab/attach.ts` / `presence/attach.ts` / `notifications/attach.ts`
 * (see `.feature-state/specs/feature-ws-namespace-attach-primitive.md`).
 *
 * Coverage, per the task's AC:
 *   - AC-1: upgrade filtering (bare/prefixed path accepted, non-match
 *     falls through to a sibling handler rather than being destroyed).
 *   - AC-3: the "register close/error before the async resolveContext await"
 *     race fix — BOTH listeners must already be attached before
 *     `resolveContext` is even called (not just checked afterwards via
 *     `ws.readyState`), a socket that disconnects mid-resolve must never
 *     reach `onOpen`, and an `'error'` event during that window must not
 *     crash the process.
 *   - AC-1 / AC-4: the shutdown drain sequence (politeClose, once per
 *     tracked connection → wait `drainMs` → afterDrain → force-terminate
 *     stragglers → `wss.close()`), its idempotency, and that an error
 *     thrown by any namespace-supplied step (politeClose / terminate /
 *     wss.close) is caught rather than aborting the rest of the sequence.
 *   - the identity `resolveContext` path (collab's shape): every upgrade is
 *     accepted immediately with the raw `IncomingMessage` as context.
 */

// Flake-proofing by construction (#917 postmortem): every wait in this file is
// EVENT-driven with no local deadline — a positive expectation awaits the event
// itself (`openWs` / `waitForCloseCode`), so a slow-but-correct CI run can
// never flake it; only a genuinely broken accept/close path fails, via jest's
// outer test timeout (raised here because a loaded runner can make several
// correct socket round-trips add up). Negative expectations ("this upgrade is
// NOT accepted") never watch a socket for the absence of an event — absence-
// within-a-window is inherently a race — they assert the mechanism directly
// (a synchronously-emitted fake upgrade must not touch the socket; shutdown
// must remove the 'upgrade' listener).
jest.setTimeout(30_000);

interface RunningServer {
  server: http.Server;
  port: number;
}

async function listen(server: http.Server): Promise<RunningServer> {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  return { server, port };
}

async function closeServer(server: http.Server): Promise<void> {
  (server as unknown as { closeAllConnections?: () => void }).closeAllConnections?.();
  await new Promise<void>((resolve) => {
    let resolved = false;
    const finish = (): void => {
      if (resolved) return;
      resolved = true;
      resolve();
    };
    const timer = setTimeout(finish, 1000);
    server.close(() => {
      clearTimeout(timer);
      finish();
    });
  });
}

/**
 * Open a WebSocket and resolve once `open` fires. Deliberately NO local
 * deadline: the event either comes (however slowly — CI load cannot fail
 * this) or the accept path is genuinely broken and jest's outer timeout
 * fails the test. Rejects if the connection closes/errors before opening,
 * so a wrongly-rejected upgrade fails fast with the close code in the
 * message rather than hanging to the outer timeout.
 */
function openWs(url: string): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    ws.on('open', () => resolve(ws));
    ws.on('close', (code: number) => reject(new Error(`closed before open (code ${code})`)));
    ws.on('error', () => {
      // `close` follows `error`; reject there with the code.
    });
  });
}

/**
 * Connect and resolve with the close code of the FIRST close event —
 * whether the server rejects pre-open or closes after opening. Same
 * deadline-free contract as `openWs`.
 */
function waitForCloseCode(url: string): Promise<number> {
  return new Promise((resolve) => {
    const ws = new WebSocket(url);
    ws.on('close', (code: number) => resolve(code));
    ws.on('error', () => {
      // `close` follows `error`.
    });
  });
}

/**
 * Synchronously emit a fake `'upgrade'` on the server and return spies for
 * every way an upgrade handler could touch the socket. This is how the
 * NEGATIVE assertions ("this path is not claimed / not accepted") are made
 * deterministic: `http.Server` runs `'upgrade'` listeners synchronously, so
 * right after `emit` returns, an untouched socket PROVES no handler claimed
 * it — no real socket, no clock, no race. (A regressed handler that DID
 * accept it would have to write handshake bytes / destroy — the spies.)
 */
function emitFakeUpgrade(server: http.Server, url: string): { destroy: jest.Mock; write: jest.Mock; end: jest.Mock } {
  const destroy = jest.fn();
  const write = jest.fn();
  const end = jest.fn();
  const fakeSocket = { destroy, write, end, on: jest.fn(), once: jest.fn(), removeListener: jest.fn(), setTimeout: jest.fn() };
  const fakeRequest = { url, headers: {}, method: 'GET' };
  server.emit('upgrade', fakeRequest as unknown as IncomingMessage, fakeSocket as unknown as import('node:stream').Duplex, Buffer.alloc(0));
  return { destroy, write, end };
}

describe('attachWsNamespace — upgrade filtering (AC-1)', () => {
  it('accepts the bare path and a prefixed sub-path, and lets a sibling upgrade handler claim a non-matching path', async () => {
    const server = http.createServer();
    const opened: string[] = [];

    attachWsNamespace<IncomingMessage>(server, {
      path: '/foo',
      resolveContext: async (request) => request,
      onOpen: (ws) => {
        opened.push('foo');
        ws.close(1000);
      },
      politeClose: () => {},
    });

    // Sibling raw upgrade handler for `/bar` — proves a non-matching
    // request is NOT `socket.destroy()`-ed by our handler (it would
    // never reach this one otherwise).
    const barWss = new WebSocketServer({ noServer: true });
    server.on('upgrade', (request, socket, head) => {
      const pathname = (request.url ?? '').split('?')[0];
      if (pathname !== '/bar') return;
      barWss.handleUpgrade(request, socket, head, (ws) => {
        opened.push('bar');
        ws.close(1000);
      });
    });

    const { server: running, port } = await listen(server);

    // Positive expectations: await the `open` event itself (deadline-free —
    // see the helpers' doc comments; #917 was this test flaking on a probe
    // window under CI load).
    (await openWs(`ws://127.0.0.1:${port}/foo`)).close();
    (await openWs(`ws://127.0.0.1:${port}/foo/doc-123`)).close();
    (await openWs(`ws://127.0.0.1:${port}/bar`)).close();

    // Negative expectation, deterministically: emit a fake `/unknown`
    // upgrade with both handlers attached — listeners run synchronously,
    // and neither may touch the socket (no destroy: siblings must keep
    // their chance; no write/end: nobody may accept an unclaimed path).
    const unknown = emitFakeUpgrade(running, '/unknown');
    expect(unknown.destroy).not.toHaveBeenCalled();
    expect(unknown.write).not.toHaveBeenCalled();
    expect(unknown.end).not.toHaveBeenCalled();

    // Device sanity — proves the fake emit really reaches the handler (the
    // /unknown silence above is a filter decision, not a vacuous emit): a
    // MATCHING path with a bogus handshake (no sec-websocket-key) makes
    // `wss.handleUpgrade` abort onto the socket, which the spies observe.
    const claimed = emitFakeUpgrade(running, '/foo');
    expect(claimed.write.mock.calls.length + claimed.end.mock.calls.length + claimed.destroy.mock.calls.length).toBeGreaterThan(0);

    expect(opened).toEqual(['foo', 'foo', 'bar']);
    await closeServer(running);
  });
});

describe('attachWsNamespace — authenticate race fix (AC-3)', () => {
  it('never calls onOpen when the socket disconnects while authenticate is still pending', async () => {
    const server = http.createServer();
    let resolveAuth: ((ctx: { id: string } | null) => void) | null = null;
    const pending = new Promise<{ id: string } | null>((resolve) => {
      resolveAuth = resolve;
    });
    const onOpen = jest.fn();
    const onClose = jest.fn();

    // Deadline-free "server observed the close" signal: the listener is
    // attached inside resolveContext — i.e. at handleUpgrade time, before the
    // client can possibly terminate — so awaiting it can neither miss an
    // already-fired close nor race a fixed sleep against TCP teardown.
    let serverSawClose!: Promise<void>;
    attachWsNamespace<{ id: string }>(server, {
      path: '/slow',
      resolveContext: async (_request, ws) => {
        serverSawClose = new Promise<void>((resolve) => ws.on('close', () => resolve()));
        return pending;
      },
      onOpen,
      onClose,
      politeClose: () => {},
    });

    const { server: running, port } = await listen(server);

    const client = new WebSocket(`ws://127.0.0.1:${port}/slow`);
    await new Promise<void>((resolve) => client.on('open', () => resolve()));
    // Disconnect immediately, well before `authenticate` resolves — then wait
    // for the SERVER to have observed it (event, not a sleep).
    client.terminate();
    await serverSawClose;

    resolveAuth!({ id: 'abc' });
    // One breather so wireConnection's post-await chain (which would call
    // onOpen if the guard regressed) has run. Absence-after-settle is safe:
    // the chain is synchronous once the promise resolves, so waiting longer
    // could only strengthen the assertion, never break it.
    await new Promise((r) => setTimeout(r, 100));

    // The phantom-connection bug this fix prevents: without it, `onOpen`
    // would still run for an already-dead socket.
    expect(onOpen).not.toHaveBeenCalled();
    // Never opened, so the post-open `onClose` never fires either — the
    // primitive's own bookkeeping never registered this socket.
    expect(onClose).not.toHaveBeenCalled();

    await closeServer(running);
  });

  it('never opens (or tracks) a socket whose resolveContext settles after shutdown began — no ghost connection past the drain', async () => {
    const server = http.createServer();
    let resolveCtx: ((ctx: { id: string } | null) => void) | null = null;
    const pending = new Promise<{ id: string } | null>((resolve) => {
      resolveCtx = resolve;
    });
    const onOpen = jest.fn();

    const wsNamespace = attachWsNamespace<{ id: string }>(server, {
      path: '/slow-shutdown',
      resolveContext: async () => pending,
      onOpen,
      politeClose: () => {},
    });

    const { server: running, port } = await listen(server);

    const client = new WebSocket(`ws://127.0.0.1:${port}/slow-shutdown`);
    await new Promise<void>((resolve) => client.on('open', () => resolve()));
    // Client stays connected; the server is mid-resolveContext for it.

    // Shutdown drains now — this socket is not yet in `connections`, so it
    // escapes the drain. Without the didShutdown guard it would add itself +
    // fire onOpen after shutdown returned.
    await wsNamespace.shutdown();

    // resolveContext only settles AFTER shutdown has returned.
    resolveCtx!({ id: 'late' });
    await new Promise((r) => setTimeout(r, 100));

    expect(onOpen).not.toHaveBeenCalled();

    await closeServer(running);
  });

  it('registers the error listener before authenticate resolves, so an error mid-await never crashes the process', async () => {
    const server = http.createServer();
    let capturedWs: WebSocket | null = null;
    let resolveAuth: ((ctx: { id: string } | null) => void) | null = null;
    const pending = new Promise<{ id: string } | null>((resolve) => {
      resolveAuth = resolve;
    });
    const consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});

    attachWsNamespace<{ id: string }>(server, {
      path: '/erroring',
      resolveContext: async (_request, ws) => {
        capturedWs = ws as unknown as WebSocket;
        return pending;
      },
      onOpen: () => {},
      politeClose: () => {},
    });

    const { server: running, port } = await listen(server);
    const client = new WebSocket(`ws://127.0.0.1:${port}/erroring`);
    await new Promise<void>((resolve) => client.on('open', () => resolve()));
    await new Promise((r) => setTimeout(r, 50));

    expect(capturedWs).not.toBeNull();
    // Emitting 'error' with zero listeners would throw synchronously
    // (Node EventEmitter behaviour) and fail this test file outright —
    // reaching the assertion below proves a listener was already there.
    capturedWs!.emit('error', new Error('boom'));
    expect(consoleErrorSpy).toHaveBeenCalled();

    resolveAuth!(null);
    consoleErrorSpy.mockRestore();
    client.terminate();
    await closeServer(running);
  });

  it('registers the close listener before calling authenticate — not only checked afterwards via ws.readyState', async () => {
    const server = http.createServer();
    let capturedWs: WebSocket | null = null;
    let resolveAuth: ((ctx: { id: string } | null) => void) | null = null;
    const pending = new Promise<{ id: string } | null>((resolve) => {
      resolveAuth = resolve;
    });

    attachWsNamespace<{ id: string }>(server, {
      path: '/close-order',
      resolveContext: async (_request, ws) => {
        capturedWs = ws as unknown as WebSocket;
        // The primitive must have already attached its own `close`
        // listener by the time `authenticate` starts running — this is
        // what lets a `close` that fires DURING this await be observed
        // at all (AC-3 spells out "close AND error", not just error +
        // a post-hoc `readyState` check).
        expect(capturedWs.listenerCount('close')).toBeGreaterThan(0);
        return pending;
      },
      onOpen: () => {},
      politeClose: () => {},
    });

    const { server: running, port } = await listen(server);
    const client = new WebSocket(`ws://127.0.0.1:${port}/close-order`);
    await new Promise<void>((resolve) => client.on('open', () => resolve()));
    await new Promise((r) => setTimeout(r, 50));

    expect(capturedWs).not.toBeNull();
    resolveAuth!(null);
    client.terminate();
    await closeServer(running);
  });

  it("rejects a connection when authenticate returns null, without ever calling onOpen — close code is the caller's own", async () => {
    const server = http.createServer();
    const onOpen = jest.fn();

    attachWsNamespace<{ id: string }>(server, {
      path: '/reject',
      resolveContext: async (_request, ws) => {
        ws.close(4401, 'nope');
        return null;
      },
      onOpen,
      politeClose: () => {},
    });

    const { server: running, port } = await listen(server);
    // The server actively closes with 4401, so the close event WILL arrive —
    // await it deadline-free rather than racing a probe window.
    const closeCode = await waitForCloseCode(`ws://127.0.0.1:${port}/reject`);
    expect(closeCode).toBe(4401);
    expect(onOpen).not.toHaveBeenCalled();

    await closeServer(running);
  });

  it('calls onOpen once accepted, and onClose when the client disconnects normally', async () => {
    const server = http.createServer();
    // Deferred-wrapping spies: the assertions await the callback EVENTS
    // instead of sleeping a fixed window after a client-side signal (a
    // loaded runner can stretch the server-side round trip past any fixed
    // sleep — the same #917 race class, just narrower).
    let onOpenFired!: () => void;
    const onOpenSeen = new Promise<void>((resolve) => {
      onOpenFired = resolve;
    });
    let onCloseFired!: () => void;
    const onCloseSeen = new Promise<void>((resolve) => {
      onCloseFired = resolve;
    });
    const onOpen = jest.fn(() => onOpenFired());
    const onClose = jest.fn(() => onCloseFired());

    attachWsNamespace<{ id: string }>(server, {
      path: '/ok',
      resolveContext: async () => ({ id: 'context-value' }),
      onOpen,
      onClose,
      politeClose: () => {},
    });

    const { server: running, port } = await listen(server);
    const client = new WebSocket(`ws://127.0.0.1:${port}/ok`);
    // Await BOTH sides' open events (client-side too — `ws` throws on a
    // `close()` before the client handshake completes). Both are events,
    // no deadlines.
    await new Promise<void>((resolve) => client.on('open', () => resolve()));
    await onOpenSeen;

    expect(onOpen).toHaveBeenCalledTimes(1);
    expect(onOpen.mock.calls[0][1]).toEqual({ id: 'context-value' });
    expect(onClose).not.toHaveBeenCalled();

    client.close();
    await onCloseSeen;
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledWith({ id: 'context-value' });

    await closeServer(running);
  });
});

describe('attachWsNamespace — identity resolveContext (collab shape)', () => {
  it('accepts every upgrade immediately with the raw IncomingMessage as context', async () => {
    const server = http.createServer();
    const seenUrls: string[] = [];

    attachWsNamespace<IncomingMessage>(server, {
      path: '/noauth',
      // collab's shape: resolveContext is the identity — no attach-time gate.
      resolveContext: async (request) => request,
      onOpen: (ws, request) => {
        seenUrls.push(request.url ?? '');
        ws.close(1000);
      },
      politeClose: () => {},
    });

    const { server: running, port } = await listen(server);
    const ws = await openWs(`ws://127.0.0.1:${port}/noauth?x=1`);
    ws.close();
    expect(seenUrls).toEqual(['/noauth?x=1']);

    await closeServer(running);
  });
});

describe('attachWsNamespace — shutdown drain sequence', () => {
  it('runs politeClose (once per connection) -> wait drainMs -> afterDrain -> force-terminate stragglers -> wss.close(), and is idempotent', async () => {
    const server = http.createServer();
    const order: string[] = [];
    const drainMs = 100;

    // Per the spec's `politeClose(context, ws)` contract, the primitive
    // calls this once per tracked connection (not once with the whole
    // map) — asserted below via `toHaveBeenCalledWith`.
    const politeCloseSpy = jest.fn((_context: undefined, _ws: WebSocket) => {
      order.push('politeClose');
      // Deliberately does NOT close the socket — simulates a straggler
      // client that never responds to the polite close, so the
      // force-terminate step has something to do.
    });
    const afterDrainSpy = jest.fn(() => {
      order.push('afterDrain');
    });

    const wsNamespace = attachWsNamespace<undefined>(server, {
      path: '/drain',
      resolveContext: async () => undefined,
      onOpen: () => {
        order.push('onOpen');
      },
      politeClose: politeCloseSpy,
      afterDrain: afterDrainSpy,
      drainMs,
    });

    const { server: running, port } = await listen(server);
    const client = new WebSocket(`ws://127.0.0.1:${port}/drain`);
    const clientClosed = new Promise<number>((resolve) => client.on('close', (code: number) => resolve(code)));
    await new Promise<void>((resolve) => client.on('open', () => resolve()));
    await new Promise((r) => setTimeout(r, 50));
    expect(order).toEqual(['onOpen']);

    const start = Date.now();
    await wsNamespace.shutdown();
    const elapsed = Date.now() - start;

    expect(politeCloseSpy).toHaveBeenCalledTimes(1);
    expect(politeCloseSpy).toHaveBeenCalledWith(undefined, expect.any(Object));
    expect(afterDrainSpy).toHaveBeenCalledTimes(1);
    expect(order).toEqual(['onOpen', 'politeClose', 'afterDrain']);
    // A small allowance for scheduler jitter under load.
    expect(elapsed).toBeGreaterThanOrEqual(drainMs - 15);

    // The straggler (never closed by `politeClose`) must still be
    // forcibly torn down by the terminate step — the client eventually
    // observes a close, proving the socket didn't hang forever.
    await expect(clientClosed).resolves.toEqual(expect.any(Number));

    // Idempotent: a second call is a no-op — none of the hooks fire again.
    await wsNamespace.shutdown();
    expect(politeCloseSpy).toHaveBeenCalledTimes(1);
    expect(afterDrainSpy).toHaveBeenCalledTimes(1);

    await closeServer(running);
  }, 15000);

  it('never calls politeClose and skips the drain wait when there are no live connections', async () => {
    const server = http.createServer();
    const politeCloseSpy = jest.fn();
    const wsNamespace = attachWsNamespace<undefined>(server, {
      path: '/empty',
      resolveContext: async () => undefined,
      onOpen: () => {},
      politeClose: politeCloseSpy,
      drainMs: 5000, // would make the test hang if the "skip when empty" path regressed
    });
    const { server: running } = await listen(server);

    const start = Date.now();
    await wsNamespace.shutdown();
    const elapsed = Date.now() - start;

    expect(politeCloseSpy).not.toHaveBeenCalled();
    expect(elapsed).toBeLessThan(1000);

    await closeServer(running);
  });

  it('removes the upgrade listener on shutdown so no further connection is accepted', async () => {
    const server = http.createServer();
    const wsNamespace = attachWsNamespace<undefined>(server, {
      path: '/after-shutdown',
      resolveContext: async () => undefined,
      onOpen: () => {},
      politeClose: () => {},
    });
    const { server: running } = await listen(server);

    // Assert the mechanism itself, deterministically: attach registered
    // exactly one 'upgrade' listener; shutdown must remove it. (A socket
    // probe here would be an absence-over-time race — see the file header.)
    expect(running.listenerCount('upgrade')).toBe(1);
    await wsNamespace.shutdown();
    expect(running.listenerCount('upgrade')).toBe(0);

    // Belt-and-suspenders via the same deterministic fake-upgrade device:
    // with zero listeners, an upgrade for the namespace path touches nothing.
    const afterShutdown = emitFakeUpgrade(running, '/after-shutdown');
    expect(afterShutdown.write).not.toHaveBeenCalled();
    expect(afterShutdown.end).not.toHaveBeenCalled();

    await closeServer(running);
  });

  it('calls wss.close() exactly once during shutdown', async () => {
    const server = http.createServer();
    const closeSpy = jest.spyOn(WebSocketServer.prototype, 'close');
    const wsNamespace = attachWsNamespace<undefined>(server, {
      path: '/wss-close',
      resolveContext: async () => undefined,
      onOpen: () => {},
      politeClose: () => {},
    });
    const { server: running } = await listen(server);

    await wsNamespace.shutdown();
    expect(closeSpy).toHaveBeenCalledTimes(1);

    closeSpy.mockRestore();
    await closeServer(running);
  });

  it('AC-6: swallows errors thrown by politeClose, terminate, and wss.close individually, and still completes shutdown', async () => {
    const server = http.createServer();
    const consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    let serverWs: WebSocket | null = null;

    const wsNamespace = attachWsNamespace<undefined>(server, {
      path: '/shutdown-errors',
      resolveContext: async () => undefined,
      onOpen: (ws) => {
        serverWs = ws as unknown as WebSocket;
      },
      politeClose: () => {
        throw new Error('politeClose boom');
      },
      drainMs: 10,
    });

    const { server: running, port } = await listen(server);
    const client = new WebSocket(`ws://127.0.0.1:${port}/shutdown-errors`);
    await new Promise<void>((resolve) => client.on('open', () => resolve()));
    await new Promise((r) => setTimeout(r, 50));
    expect(serverWs).not.toBeNull();

    // Force the force-terminate step and `wss.close()` to also throw —
    // proves each step's own try/catch is independent: one throwing
    // must not skip the remaining steps.
    jest.spyOn(serverWs as unknown as WebSocket, 'terminate').mockImplementation(() => {
      throw new Error('terminate boom');
    });
    const wssCloseSpy = jest.spyOn(WebSocketServer.prototype, 'close').mockImplementation(() => {
      throw new Error('wss.close boom');
    });

    await expect(wsNamespace.shutdown()).resolves.toBeUndefined();

    expect(consoleErrorSpy).toHaveBeenCalledWith(expect.stringContaining('politeClose failed'), expect.any(Error));
    expect(consoleErrorSpy).toHaveBeenCalledWith(expect.stringContaining('terminate failed'), expect.any(Error));
    expect(consoleErrorSpy).toHaveBeenCalledWith(expect.stringContaining('wss.close failed'), expect.any(Error));

    wssCloseSpy.mockRestore();
    consoleErrorSpy.mockRestore();
    client.terminate();
    await closeServer(running);
  });
});
