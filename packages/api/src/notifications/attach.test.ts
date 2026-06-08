// Pin a stable WS_TOKEN_SECRET *before* the attach module loads.
// The util now reads the env per-call, but the module-load-time
// missing-secret warn still inspects it at import time.
process.env.WS_TOKEN_SECRET = process.env.WS_TOKEN_SECRET ?? 'test-ws-token-secret-base64-32bytes-=';

import http from 'node:http';
import { AddressInfo } from 'node:net';
import WebSocket from 'ws';

import type Crowi from 'src/crowi';
import { createNotificationsTokenUtil } from 'src/util/notifications-token';

import { attachNotificationsServer, channelForUser, type AttachedNotifications, type NotificationsRedisClient } from './attach';

/**
 * Tests for `attachNotificationsServer` — the third `ws noServer`
 * handler on the api http.Server alongside `/collab` and `/presence`.
 *
 * What this suite covers (per spec AC):
 *   - token auth: valid token connects, invalid / expired / mismatched
 *     selfUserId tokens are rejected with 4401 / 4403,
 *   - Redis subscribe lifecycle: first connection for a userId
 *     subscribes, last close unsubscribes (one subscribe regardless
 *     of tab count for the same user),
 *   - per-user channel isolation: a publish on user A's channel never
 *     reaches user B's sockets,
 *   - degraded mode: when `crowi.redis === null` the WebSocket still
 *     attaches and accepts connections (no pub/sub fan-out),
 *   - drain shutdown: SIGINT-style teardown closes all live sockets.
 *
 * Uses an in-memory FakeRedis that mirrors the structural
 * `NotificationsRedisClient` surface. Subscribers share one backing
 * store with the primary client so a `publish` round-trips through
 * the subscribe listener without going out to a real Redis — same
 * pattern as `service/presence.test.ts`.
 */

class FakeRedis implements NotificationsRedisClient {
  isOpen = true;
  /** Shared subscriber registry — duplicated clients see the same set. */
  private readonly subscribers: Map<string, Array<(message: string) => void>>;
  /** Per-instance subscribed channels — used to assert lazy subscribe/unsubscribe. */
  readonly subscribedChannels: Set<string>;
  /** Records every publish/subscribe/unsubscribe to make ordering assertions trivial. */
  readonly events: Array<{ kind: 'subscribe' | 'unsubscribe' | 'publish'; channel: string }>;

  constructor(shared?: {
    subscribers: Map<string, Array<(message: string) => void>>;
    events: Array<{ kind: 'subscribe' | 'unsubscribe' | 'publish'; channel: string }>;
  }) {
    this.subscribers = shared?.subscribers ?? new Map();
    this.events = shared?.events ?? [];
    this.subscribedChannels = new Set();
  }

  async publish(channel: string, message: string): Promise<number> {
    this.events.push({ kind: 'publish', channel });
    const listeners = this.subscribers.get(channel) ?? [];
    for (const listener of listeners) {
      // Synchronous delivery so tests don't need to await a tick.
      listener(message);
    }
    return listeners.length;
  }

  async subscribe(channel: string, listener: (message: string) => void): Promise<void> {
    this.events.push({ kind: 'subscribe', channel });
    this.subscribedChannels.add(channel);
    const listeners = this.subscribers.get(channel) ?? [];
    listeners.push(listener);
    this.subscribers.set(channel, listeners);
  }

  async unsubscribe(channel: string): Promise<void> {
    this.events.push({ kind: 'unsubscribe', channel });
    this.subscribedChannels.delete(channel);
    this.subscribers.delete(channel);
  }

  duplicate(): NotificationsRedisClient {
    return new FakeRedis({ subscribers: this.subscribers, events: this.events });
  }

  async connect(): Promise<unknown> {
    return undefined;
  }

  async disconnect(): Promise<unknown> {
    return undefined;
  }
}

/** Build a minimal crowi-shaped object: only `redis` is read by the attach. */
const fakeCrowi = (redis: NotificationsRedisClient | null): Crowi => ({ redis }) as unknown as Crowi;

interface TestServer {
  server: http.Server;
  port: number;
  attachment: AttachedNotifications;
  primary: FakeRedis | null;
}

async function startTestServer(opts: { redis?: 'on' | 'off' } = {}): Promise<TestServer> {
  const primary = opts.redis === 'off' ? null : new FakeRedis();
  const server = http.createServer();
  const crowi = fakeCrowi(primary);
  const attachment = await attachNotificationsServer(server, crowi);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  return { server, port, attachment, primary };
}

async function stopTestServer(s: TestServer): Promise<void> {
  try {
    await s.attachment.shutdown();
  } catch {
    // best-effort
  }
  // The Node test server may still hold half-closed peers; drop them
  // so `close()` calls back deterministically. Mirrors the collab
  // attach test (Node 18.2+ `closeAllConnections`).
  (s.server as unknown as { closeAllConnections?: () => void }).closeAllConnections?.();
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

/** Open a WebSocket and resolve with the result observed within `timeoutMs`. */
function probeWs(
  url: string,
  opts: { timeoutMs?: number; onOpen?: (ws: WebSocket) => void; collectMessage?: boolean } = {},
): Promise<{ opened: boolean; closeCode?: number; messages: string[] }> {
  const { timeoutMs = 1500, onOpen, collectMessage = false } = opts;
  return new Promise((resolve) => {
    const ws = new WebSocket(url);
    const messages: string[] = [];
    let settled = false;
    let opened = false;
    let closeCode: number | undefined;
    const settle = (): void => {
      if (settled) return;
      settled = true;
      try {
        ws.close();
      } catch {
        // ignore
      }
      resolve({ opened, closeCode, messages });
    };
    ws.on('open', () => {
      opened = true;
      onOpen?.(ws);
      if (!collectMessage) {
        // Give the server a beat to send the close frame before we
        // settle on the open side — relevant for the happy-path tests
        // that don't care about messages.
        setTimeout(settle, 50);
      }
    });
    ws.on('message', (data: Buffer | string) => {
      messages.push(typeof data === 'string' ? data : data.toString('utf8'));
    });
    ws.on('close', (code: number) => {
      closeCode = code;
      settle();
    });
    ws.on('error', () => {
      // Let close settle.
    });
    setTimeout(settle, timeoutMs);
  });
}

/**
 * Open a WebSocket and resolve with the WS close code once the server
 * closes the connection. Unlike `probeWs`, this waits for the `close`
 * event itself rather than racing it against a fixed budget — the close
 * code is exactly what reject-path tests assert, so settling early on a
 * timeout would feed `undefined` into the assertion (the observed CI
 * flake). Jest's per-test timeout is the backstop; if the close never
 * arrives we reject with an explicit message instead of resolving with
 * an undefined code. Mirrors the `waitUntil` polling philosophy already
 * used for the happy-path subscribe assertions.
 */
function expectWsClose(url: string, timeoutMs = 10000): Promise<number> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try {
        ws.close();
      } catch {
        // ignore
      }
      reject(new Error(`expectWsClose: no WS close frame within ${timeoutMs}ms for ${url}`));
    }, timeoutMs);
    ws.on('close', (code: number) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(code);
    });
    ws.on('error', () => {
      // A transport-level error before a close frame is itself a close
      // signal for the reject path — let the `close` handler resolve.
      // If `close` never follows, the timer above rejects with an
      // explicit message instead of leaking an undefined close code.
    });
  });
}

const validTokenFor = (userId: string): string => createNotificationsTokenUtil().signNotificationsToken({ selfUserId: userId }).token;

describe('attachNotificationsServer — Redis-backed', () => {
  let testServer: TestServer;

  beforeAll(async () => {
    testServer = await startTestServer();
  }, 15000);

  afterAll(async () => {
    await stopTestServer(testServer);
  }, 15000);

  /**
   * Poll until `predicate()` returns true or the timeout elapses.
   * Used in lieu of a fixed sleep — the server's `wireConnection`
   * runs the subscribe asynchronously after the WS handshake's
   * `open` event fires, so the subscribe-event-recorded condition
   * is what we actually want to gate the assertion on. A flat sleep
   * was flaky on busy CI workers (parallel test load delays the
   * subscribe round-trip past a fixed budget).
   */
  const waitUntil = async (predicate: () => boolean, timeoutMs = 2000): Promise<void> => {
    const start = Date.now();
    while (!predicate()) {
      if (Date.now() - start > timeoutMs) throw new Error(`waitUntil timed out after ${timeoutMs}ms`);
      await new Promise((r) => setTimeout(r, 10));
    }
  };

  it('accepts a valid token + matching path userId and subscribes the user channel', async () => {
    const userId = 'user-A';
    const token = validTokenFor(userId);

    // Open the connection explicitly (rather than via the fire-and-
    // forget `probeWs`) so the test can wait deterministically for
    // the `subscribe` side effect before asserting.
    const ws = new WebSocket(`ws://127.0.0.1:${testServer.port}/notifications/${userId}?token=${token}`);
    await new Promise<void>((resolve) => ws.on('open', () => resolve()));

    // Note: the subscriber is a duplicate(); we check the events log
    // on the shared backing store rather than the primary's own
    // `subscribedChannels` (which is the per-instance set).
    expect(testServer.primary).not.toBeNull();
    await waitUntil(() => testServer.primary!.events.some((e) => e.kind === 'subscribe' && e.channel === channelForUser(userId)));

    // Close from the client side so the server's last-close path runs.
    await new Promise<void>((resolve) => {
      ws.on('close', () => resolve());
      ws.close();
    });
  });

  it('rejects a missing token with WS close 4401', async () => {
    const url = `ws://127.0.0.1:${testServer.port}/notifications/user-A`;
    const closeCode = await expectWsClose(url);
    expect(closeCode).toBe(4401);
  }, 15000);

  it('rejects an invalid token with WS close 4401', async () => {
    const url = `ws://127.0.0.1:${testServer.port}/notifications/user-A?token=not-a-jwt`;
    const closeCode = await expectWsClose(url);
    expect(closeCode).toBe(4401);
  }, 15000);

  it('rejects a token whose selfUserId does not match the path with WS close 4403', async () => {
    // Token signed for user-A but presented on user-B's URL — the spec's
    // "自分宛て以外の publish が WS に流れない" guarantee starts here.
    const token = validTokenFor('user-A');
    const url = `ws://127.0.0.1:${testServer.port}/notifications/user-B?token=${token}`;
    const closeCode = await expectWsClose(url);
    expect(closeCode).toBe(4403);
  }, 15000);

  it('does NOT upgrade when the path is not under /notifications/', async () => {
    const url = `ws://127.0.0.1:${testServer.port}/some/other/path?token=${validTokenFor('user-A')}`;
    const result = await probeWs(url);
    // No other upgrade handler is registered on the test server, so
    // the request falls through to a 1xxx close code, never opened.
    expect(result.opened).toBe(false);
  });

  it('subscribes once for multiple tabs of the same user and unsubscribes only on the last close', async () => {
    const userId = 'user-multi';
    const token = validTokenFor(userId);
    const subscribeCount = () => testServer.primary!.events.filter((e) => e.kind === 'subscribe' && e.channel === channelForUser(userId)).length;
    const unsubscribeCount = () => testServer.primary!.events.filter((e) => e.kind === 'unsubscribe' && e.channel === channelForUser(userId)).length;
    const baselineSubscribes = subscribeCount();
    const baselineUnsubscribes = unsubscribeCount();

    // Open two "tabs" for the same user serially. Opening serially
    // (not in parallel) keeps the "first-for-user" race window out of
    // the test: with two parallel opens, both `wireConnection` runs
    // can see an empty connections map and BOTH may call
    // `ensureSubscribed` before the first one finishes. The handler
    // is correct in production (a duplicate subscribe is a no-op at
    // node-redis level), but the assertion below asks for exactly one
    // recorded subscribe event, so we serialise here.
    const openSocket = (): Promise<WebSocket> => {
      return new Promise((resolve) => {
        const ws = new WebSocket(`ws://127.0.0.1:${testServer.port}/notifications/${userId}?token=${token}`);
        ws.on('open', () => resolve(ws));
      });
    };
    const ws1 = await openSocket();
    // Wait for the first subscribe event before opening the second tab.
    await waitUntil(() => subscribeCount() - baselineSubscribes >= 1);
    const ws2 = await openSocket();

    // Exactly one fresh subscribe regardless of tab count.
    expect(subscribeCount() - baselineSubscribes).toBe(1);

    // Close one tab — the channel must remain subscribed.
    await new Promise<void>((resolve) => {
      ws1.on('close', () => resolve());
      ws1.close();
    });
    expect(unsubscribeCount() - baselineUnsubscribes).toBe(0);

    // Close the last tab — unsubscribe fires now (await the event,
    // not a fixed sleep — the server's `handleClose` is async).
    await new Promise<void>((resolve) => {
      ws2.on('close', () => resolve());
      ws2.close();
    });
    await waitUntil(() => unsubscribeCount() - baselineUnsubscribes >= 1);
    expect(unsubscribeCount() - baselineUnsubscribes).toBe(1);
  });

  it('forwards a publish on the user channel to every locally-connected socket for that user', async () => {
    const userId = 'user-pub';
    const token = validTokenFor(userId);

    const ws = new WebSocket(`ws://127.0.0.1:${testServer.port}/notifications/${userId}?token=${token}`);
    const messages: string[] = [];
    ws.on('message', (data: Buffer | string) => {
      messages.push(typeof data === 'string' ? data : data.toString('utf8'));
    });
    await new Promise<void>((resolve) => ws.on('open', () => resolve()));
    // Wait for the subscribe so the publish below actually reaches us.
    await waitUntil(() => testServer.primary!.events.some((e) => e.kind === 'subscribe' && e.channel === channelForUser(userId)));

    // Simulate the model layer publishing a "changed" tick.
    await testServer.primary!.publish(channelForUser(userId), JSON.stringify({ type: 'changed' }));
    // Settle the WS frame onto the client.
    await waitUntil(() => messages.length >= 1);
    expect(JSON.parse(messages[0])).toEqual({ type: 'changed' });

    await new Promise<void>((resolve) => {
      ws.on('close', () => resolve());
      ws.close();
    });
  });

  it('does NOT forward a publish on another user channel to the wrong user', async () => {
    const userA = 'user-iso-A';
    const userB = 'user-iso-B';
    const tokenA = validTokenFor(userA);

    const ws = new WebSocket(`ws://127.0.0.1:${testServer.port}/notifications/${userA}?token=${tokenA}`);
    const messages: string[] = [];
    ws.on('message', (data: Buffer | string) => {
      messages.push(typeof data === 'string' ? data : data.toString('utf8'));
    });
    await new Promise<void>((resolve) => ws.on('open', () => resolve()));
    await waitUntil(() => testServer.primary!.events.some((e) => e.kind === 'subscribe' && e.channel === channelForUser(userA)));

    // Publish on user B's channel — A's socket must remain quiet.
    await testServer.primary!.publish(channelForUser(userB), JSON.stringify({ type: 'changed' }));
    // Then publish a sentinel on A's OWN channel, which is genuinely
    // delivered. Because FakeRedis fans out synchronously in publish
    // order and the WS frames queue onto the socket in that same order,
    // any (erroneous) cross-channel frame would land BEFORE the sentinel.
    // So once the sentinel arrives, `messages` must contain exactly it —
    // proving the user-B publish never leaked to A — without depending on
    // a fixed sleep that a busy worker could under- or over-shoot.
    await testServer.primary!.publish(channelForUser(userA), JSON.stringify({ type: 'changed' }));
    await waitUntil(() => messages.length >= 1);
    expect(messages).toHaveLength(1);
    expect(JSON.parse(messages[0])).toEqual({ type: 'changed' });

    await new Promise<void>((resolve) => {
      ws.on('close', () => resolve());
      ws.close();
    });
  });
});

describe('attachNotificationsServer — drain shutdown', () => {
  it('closes every live socket on shutdown', async () => {
    const server = await startTestServer();
    const token = validTokenFor('user-shutdown');
    const ws = new WebSocket(`ws://127.0.0.1:${server.port}/notifications/user-shutdown?token=${token}`);
    await new Promise<void>((resolve) => ws.on('open', () => resolve()));

    // Trigger shutdown — the WS handler must close every live socket
    // with the "going away" code 1001.
    const closePromise = new Promise<number>((resolve) => ws.on('close', (code: number) => resolve(code)));
    await server.attachment.shutdown();
    const closeCode = await closePromise;
    expect(closeCode).toBe(1001);

    // Subsequent calls are idempotent.
    await server.attachment.shutdown();

    (server.server as unknown as { closeAllConnections?: () => void }).closeAllConnections?.();
    await new Promise<void>((resolve) => server.server.close(() => resolve()));
  }, 15000);
});

describe('attachNotificationsServer — degraded mode (no Redis)', () => {
  it('attaches without Redis and accepts connections (no pub/sub fan-out)', async () => {
    const server = await startTestServer({ redis: 'off' });
    const token = validTokenFor('user-degraded');

    // The connection should still open: degraded mode silently skips
    // subscribe + publish, but the handshake / authn path is intact.
    const result = await probeWs(`ws://127.0.0.1:${server.port}/notifications/user-degraded?token=${token}`);
    expect(result.opened).toBe(true);

    await stopTestServer(server);
  }, 15000);
});

describe('attachNotificationsServer — path handling edge cases', () => {
  /**
   * Cover the path-normalisation rules added for review items #10 / #11:
   *   - decodeURIComponent the path segment so encoded userIds (SSO
   *     ids with `@` etc.) still match the token's `selfUserId`,
   *   - trailing slash is tolerated (proxies sometimes normalise),
   *   - extra path segment (`/notifications/<id>/extra`) is rejected.
   */
  let server: TestServer;
  beforeAll(async () => {
    server = await startTestServer();
  }, 15000);
  afterAll(async () => {
    await stopTestServer(server);
  }, 15000);

  it('accepts a URL-encoded userId in the path (decodeURIComponent before compare)', async () => {
    const userId = 'user@foo';
    const token = validTokenFor(userId);
    const encoded = encodeURIComponent(userId); // `user%40foo`
    const url = `ws://127.0.0.1:${server.port}/notifications/${encoded}?token=${token}`;
    const result = await probeWs(url);
    expect(result.opened).toBe(true);
  });

  it('accepts a trailing slash on the path', async () => {
    const userId = 'user-trailing';
    const token = validTokenFor(userId);
    const url = `ws://127.0.0.1:${server.port}/notifications/${userId}/?token=${token}`;
    const result = await probeWs(url);
    expect(result.opened).toBe(true);
  });

  it('rejects an extra path segment after the userId with WS close 4403', async () => {
    const userId = 'user-extra';
    const token = validTokenFor(userId);
    const url = `ws://127.0.0.1:${server.port}/notifications/${userId}/extra?token=${token}`;
    // Note: we don't assert `opened === false` — the underlying WS
    // upgrade handshake succeeds (HTTP 101 returned by `ws`), so the
    // browser's `open` event still fires; the server then closes with
    // the application code 4403 a tick later. The mismatch-token test
    // uses the same shape. We wait on the close frame itself (not a
    // fixed budget) so a busy CI worker can't settle early with an
    // undefined close code.
    const closeCode = await expectWsClose(url);
    expect(closeCode).toBe(4403);
  }, 15000);
});

describe('attachNotificationsServer — schema-guarded fan-out (#14)', () => {
  /**
   * `handleRedisMessage` now schema-validates incoming Redis payloads
   * against `NotificationsServerMessageSchema` and drops anything that
   * does not match. Defence in depth: a foreign / malformed publish on
   * the user's channel must never reach the browser.
   */
  let server: TestServer;
  beforeAll(async () => {
    server = await startTestServer();
  }, 15000);
  afterAll(async () => {
    await stopTestServer(server);
  }, 15000);

  const waitUntil = async (predicate: () => boolean, timeoutMs = 2000): Promise<void> => {
    const start = Date.now();
    while (!predicate()) {
      if (Date.now() - start > timeoutMs) throw new Error(`waitUntil timed out after ${timeoutMs}ms`);
      await new Promise((r) => setTimeout(r, 10));
    }
  };

  it('drops a schema-invalid Redis publish and never forwards it to the WS client', async () => {
    const userId = 'user-schema-drop';
    const token = validTokenFor(userId);

    const ws = new WebSocket(`ws://127.0.0.1:${server.port}/notifications/${userId}?token=${token}`);
    const messages: string[] = [];
    ws.on('message', (data: Buffer | string) => {
      messages.push(typeof data === 'string' ? data : data.toString('utf8'));
    });
    await new Promise<void>((resolve) => ws.on('open', () => resolve()));
    await waitUntil(() => server.primary!.events.some((e) => e.kind === 'subscribe' && e.channel === channelForUser(userId)));

    // Foreign-shaped payload that JSON-parses but fails schema.
    await server.primary!.publish(channelForUser(userId), JSON.stringify({ type: 'other', data: 'spam' }));

    // A subsequent well-formed payload still gets through — proves the
    // drop is selective, not a global silence. This well-formed frame
    // doubles as a delivery sentinel: FakeRedis fans out synchronously in
    // publish order, so the schema-invalid frame above — had it (wrongly)
    // been forwarded — would queue onto the socket BEFORE this one. Once
    // the sentinel arrives, `messages` must contain exactly it, proving
    // the invalid publish was dropped. No fixed sleep needed.
    await server.primary!.publish(channelForUser(userId), JSON.stringify({ type: 'changed' }));
    await waitUntil(() => messages.length >= 1);
    expect(messages).toHaveLength(1);
    expect(JSON.parse(messages[0])).toEqual({ type: 'changed' });

    await new Promise<void>((resolve) => {
      ws.on('close', () => resolve());
      ws.close();
    });
  });
});

describe('attachNotificationsServer — subscribe/unsubscribe race serialisation (#3)', () => {
  /**
   * Without the per-user channel-op chain, a close-then-immediate-
   * reconnect on the same userId could race: the close handler's
   * async `unsubscribe` lands after the new connection's `subscribe`,
   * leaving the new socket without an active Redis subscription. The
   * chain forces FIFO ordering so the final state is `subscribed`.
   */
  let server: TestServer;
  beforeAll(async () => {
    server = await startTestServer();
  }, 15000);
  afterAll(async () => {
    await stopTestServer(server);
  }, 15000);

  it('serialises last-close / immediate-reconnect so the final Redis state is subscribed (FIFO)', async () => {
    const userId = 'user-race';
    const token = validTokenFor(userId);
    const channel = channelForUser(userId);

    const eventsFor = () => server.primary!.events.filter((e) => e.channel === channel);
    const baseline = eventsFor().length;

    // 1. Open a tab + wait for the first subscribe.
    const ws1 = new WebSocket(`ws://127.0.0.1:${server.port}/notifications/${userId}?token=${token}`);
    await new Promise<void>((resolve) => ws1.on('open', () => resolve()));
    const waitUntil = async (predicate: () => boolean, timeoutMs = 2000): Promise<void> => {
      const start = Date.now();
      while (!predicate()) {
        if (Date.now() - start > timeoutMs) throw new Error(`waitUntil timed out after ${timeoutMs}ms`);
        await new Promise((r) => setTimeout(r, 10));
      }
    };
    await waitUntil(() => eventsFor().some((e) => e.kind === 'subscribe'));

    // 2. Close + reconnect immediately. The server's handleClose runs
    //    async; if we don't await the close → reconnect ordering, the
    //    second connection's subscribe and the first connection's
    //    unsubscribe can land in arbitrary order without the chain.
    const closeP = new Promise<void>((resolve) => ws1.on('close', () => resolve()));
    ws1.close();
    await closeP;

    const ws2 = new WebSocket(`ws://127.0.0.1:${server.port}/notifications/${userId}?token=${token}`);
    await new Promise<void>((resolve) => ws2.on('open', () => resolve()));

    // 3. Wait until the chain settles — once it does, the final
    //    recorded event for this channel must be `subscribe`, not
    //    `unsubscribe`. That assertion is the FIFO ordering guarantee:
    //    a subscribe queued AFTER an unsubscribe always wins.
    await waitUntil(() => {
      const evts = eventsFor();
      return evts.length >= baseline + 3 && evts[evts.length - 1].kind === 'subscribe';
    });
    const finalEvents = eventsFor();
    expect(finalEvents[finalEvents.length - 1].kind).toBe('subscribe');

    // 4. Sanity check: a publish on the channel should reach the new
    //    socket (the subscription is live).
    const messages: string[] = [];
    ws2.on('message', (data: Buffer | string) => {
      messages.push(typeof data === 'string' ? data : data.toString('utf8'));
    });
    await server.primary!.publish(channel, JSON.stringify({ type: 'changed' }));
    await waitUntil(() => messages.length >= 1);
    expect(JSON.parse(messages[0])).toEqual({ type: 'changed' });

    await new Promise<void>((resolve) => {
      ws2.on('close', () => resolve());
      ws2.close();
    });
  }, 15000);
});
