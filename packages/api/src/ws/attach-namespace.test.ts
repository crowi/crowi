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

interface WsOutcome {
  opened: boolean;
  closeCode?: number;
}

/** Open a WebSocket and resolve with the result observed within `timeoutMs`. */
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

    const fooBare = await probeWs(`ws://127.0.0.1:${port}/foo`);
    expect(fooBare.opened).toBe(true);
    const fooPrefixed = await probeWs(`ws://127.0.0.1:${port}/foo/doc-123`);
    expect(fooPrefixed.opened).toBe(true);
    const bar = await probeWs(`ws://127.0.0.1:${port}/bar`);
    expect(bar.opened).toBe(true);

    // No handler at all for `/unknown` — the upgrade must never
    // complete (proves neither handler destroys the socket, but also
    // that a truly unclaimed path never gets a bogus accept).
    const unknown = await probeWs(`ws://127.0.0.1:${port}/unknown`, 500);
    expect(unknown.opened).toBe(false);

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

    attachWsNamespace<{ id: string }>(server, {
      path: '/slow',
      resolveContext: async () => pending,
      onOpen,
      onClose,
      politeClose: () => {},
    });

    const { server: running, port } = await listen(server);

    const client = new WebSocket(`ws://127.0.0.1:${port}/slow`);
    await new Promise<void>((resolve) => client.on('open', () => resolve()));
    // Disconnect immediately, well before `authenticate` resolves.
    client.terminate();
    // Give the server a moment to observe the close (readyState flips
    // to CLOSED asynchronously as the TCP teardown completes).
    await new Promise((r) => setTimeout(r, 150));

    resolveAuth!({ id: 'abc' });
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
    const outcome = await probeWs(`ws://127.0.0.1:${port}/reject`, 2000);
    expect(outcome.closeCode).toBe(4401);
    expect(onOpen).not.toHaveBeenCalled();

    await closeServer(running);
  });

  it('calls onOpen once accepted, and onClose when the client disconnects normally', async () => {
    const server = http.createServer();
    const onOpen = jest.fn();
    const onClose = jest.fn();

    attachWsNamespace<{ id: string }>(server, {
      path: '/ok',
      resolveContext: async () => ({ id: 'context-value' }),
      onOpen,
      onClose,
      politeClose: () => {},
    });

    const { server: running, port } = await listen(server);
    const client = new WebSocket(`ws://127.0.0.1:${port}/ok`);
    await new Promise<void>((resolve) => client.on('open', () => resolve()));
    await new Promise((r) => setTimeout(r, 50));

    expect(onOpen).toHaveBeenCalledTimes(1);
    expect(onOpen.mock.calls[0][1]).toEqual({ id: 'context-value' });
    expect(onClose).not.toHaveBeenCalled();

    await new Promise<void>((resolve) => {
      client.on('close', () => resolve());
      client.close();
    });
    await new Promise((r) => setTimeout(r, 50));
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
    const outcome = await probeWs(`ws://127.0.0.1:${port}/noauth?x=1`);
    expect(outcome.opened).toBe(true);
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
    const { server: running, port } = await listen(server);
    await wsNamespace.shutdown();

    const outcome = await probeWs(`ws://127.0.0.1:${port}/after-shutdown`, 500);
    expect(outcome.opened).toBe(false);

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
