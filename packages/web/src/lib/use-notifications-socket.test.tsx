import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { PropsWithChildren } from 'react';
import { createElement } from 'react';

// feature-web-cross-origin-runtime-env: `resolve-ws-url` now reads
// NEXT_PUBLIC_* via next-runtime-env's runtime `env()` (`./runtime-env`). Mock
// it to read live from `process.env` so the `resolveNotificationsUrl`
// precedence tests below keep driving it through `process.env`.
vi.mock('./runtime-env', () => ({
  env: (key: string) => process.env[key],
}));

// Mock `apiClientV2` so the token query reads our fake
// `notifications.token.$get`. The hook calls `apiClientV2.notifications.token.$get()`
// directly; we replace that single method.
const { getNotificationsToken } = vi.hoisted(() => ({ getNotificationsToken: vi.fn() }));
vi.mock('./api-client', () => ({
  apiClientV2: {
    notifications: {
      token: { $get: getNotificationsToken },
    },
  },
}));

// Mock `useAuth` so the hook can read an authed user id without
// dragging in next/navigation's router and the real /auth/me fetch.
// The token cache key is scoped by `authedUserId` (regression guard
// against a logout→re-login leak), so each test sets the mock return
// in its arrange step.
const { useAuthMock } = vi.hoisted(() => {
  type AuthSlice = { user: { id: string } | null };
  return { useAuthMock: vi.fn<() => AuthSlice>(() => ({ user: { id: 'me' } })) };
});
vi.mock('./use-auth', () => ({ useAuth: useAuthMock }));

import { useNotificationsSocket, resolveNotificationsUrl } from './use-notifications-socket';
import { notificationKeys } from './use-notifications';

/**
 * Minimal fake WebSocket — captures instances so tests can drive
 * `onopen` / `onmessage` / `onclose` explicitly. The notifications
 * hook only ever uses the `on*` handler properties and `close`.
 */
class FakeWebSocket {
  static OPEN = 1;
  static instances: FakeWebSocket[] = [];

  url: string;
  readyState = 0;
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onerror: (() => void) | null = null;
  onclose: ((event: { code: number }) => void) | null = null;
  close = vi.fn(() => {
    this.readyState = 3;
  });

  constructor(url: string) {
    this.url = url;
    FakeWebSocket.instances.push(this);
  }

  // Test helpers.
  open() {
    this.readyState = FakeWebSocket.OPEN;
    this.onopen?.();
  }
  emitChanged() {
    this.onmessage?.({ data: JSON.stringify({ type: 'changed' }) });
  }
  emitRaw(data: unknown) {
    this.onmessage?.({ data });
  }
  fail(code = 1006) {
    this.readyState = 3;
    this.onclose?.({ code });
  }
}

const TOKEN_OK = {
  token: 'jwt.notifications',
  selfUserId: 'me',
  expiresAt: new Date(Date.now() + 60_000).toISOString(),
};

function tokenOkResponse<T>(body: T): { ok: true; status: number; json: () => Promise<T> } {
  return { ok: true, status: 200, json: () => Promise.resolve(body) };
}

interface HarnessOptions {
  enabled?: boolean;
}

function makeHarness() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  const invalidateSpy = vi.spyOn(client, 'invalidateQueries');
  const Wrapper = ({ children }: PropsWithChildren) => createElement(QueryClientProvider, { client }, children);
  return {
    client,
    invalidateSpy,
    Wrapper,
    render(options: HarnessOptions = {}) {
      return renderHook(() => useNotificationsSocket(options), { wrapper: Wrapper });
    },
  };
}

async function flush() {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0);
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  getNotificationsToken.mockReset();
  useAuthMock.mockReset();
  useAuthMock.mockReturnValue({ user: { id: 'me' } });
  FakeWebSocket.instances.length = 0;
  vi.stubGlobal('WebSocket', FakeWebSocket);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('useNotificationsSocket', () => {
  it('does not open a WebSocket when disabled', async () => {
    getNotificationsToken.mockResolvedValue(tokenOkResponse(TOKEN_OK));
    const h = makeHarness();

    h.render({ enabled: false });
    await flush();

    // Token query is gated by `enabled` too — `getNotificationsToken`
    // must NOT be called.
    expect(getNotificationsToken).not.toHaveBeenCalled();
    expect(FakeWebSocket.instances).toHaveLength(0);
  });

  it('fetches a token then connects to /notifications/<userId> with it', async () => {
    getNotificationsToken.mockResolvedValue(tokenOkResponse(TOKEN_OK));
    const h = makeHarness();

    h.render();
    await flush();

    expect(FakeWebSocket.instances).toHaveLength(1);
    const ws = FakeWebSocket.instances[0];
    expect(ws.url).toContain('/notifications/me');
    expect(ws.url).toContain('token=jwt.notifications');
  });

  it('invalidates notificationKeys.all on a `changed` message (debounced)', async () => {
    getNotificationsToken.mockResolvedValue(tokenOkResponse(TOKEN_OK));
    const h = makeHarness();

    h.render();
    await flush();
    const ws = FakeWebSocket.instances[0];
    h.invalidateSpy.mockClear();

    act(() => {
      ws.open();
      // The initial connect deliberately does NOT fire a catch-up
      // invalidate — the REST queries already fetched on mount, and
      // an open-time invalidate would turn a broken handshake (open →
      // server-reject → close → reconnect) into an infinite refetch
      // storm. Advance past the debounce window to prove nothing was
      // scheduled.
      vi.advanceTimersByTime(200);
    });
    expect(h.invalidateSpy).not.toHaveBeenCalled();

    // A burst of `changed` ticks within the debounce window collapses
    // to a single invalidate call.
    act(() => {
      ws.emitChanged();
      ws.emitChanged();
      ws.emitChanged();
      // Advance JUST under the debounce window — nothing fires yet.
      vi.advanceTimersByTime(150);
    });
    expect(h.invalidateSpy).not.toHaveBeenCalled();

    act(() => {
      // Cross the debounce threshold — the collapsed invalidate runs.
      vi.advanceTimersByTime(100);
    });
    expect(h.invalidateSpy).toHaveBeenCalledTimes(1);
    expect(h.invalidateSpy).toHaveBeenCalledWith({ queryKey: notificationKeys.all });
  });

  it('does NOT catch-up invalidate on the very first connect (open only fires it on reconnect)', async () => {
    // Regression guard for the handshake-storm bug: when the server
    // rejects the upgrade right after the upgrade succeeds (e.g. token
    // race), an `open → invalidate → close → backoff → open → invalidate`
    // loop hammered `/notifications/status` on every cycle. The fix is
    // to skip catch-up on the initial connect (`reconnectAttempts === 0`).
    getNotificationsToken.mockResolvedValue(tokenOkResponse(TOKEN_OK));
    const h = makeHarness();

    h.render();
    await flush();
    h.invalidateSpy.mockClear();

    act(() => {
      FakeWebSocket.instances[0].open();
      vi.advanceTimersByTime(500);
    });

    expect(h.invalidateSpy).not.toHaveBeenCalledWith({ queryKey: notificationKeys.all });
  });

  it('fires a catch-up invalidate on reconnect open', async () => {
    getNotificationsToken.mockResolvedValue(tokenOkResponse(TOKEN_OK));
    const h = makeHarness();

    h.render();
    await flush();
    h.invalidateSpy.mockClear();

    // First socket opens then drops uncleanly — backoff reconnects.
    act(() => {
      FakeWebSocket.instances[0].open();
      vi.advanceTimersByTime(200);
    });
    h.invalidateSpy.mockClear();
    act(() => {
      FakeWebSocket.instances[0].fail(1006);
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(15_000);
    });
    expect(FakeWebSocket.instances).toHaveLength(2);

    // Second socket opens — catch-up invalidate fires inside the
    // debounce window.
    act(() => {
      FakeWebSocket.instances[1].open();
      vi.advanceTimersByTime(200);
    });
    expect(h.invalidateSpy).toHaveBeenCalledWith({ queryKey: notificationKeys.all });
  });

  it('ignores malformed / non-JSON frames', async () => {
    getNotificationsToken.mockResolvedValue(tokenOkResponse(TOKEN_OK));
    const h = makeHarness();

    h.render();
    await flush();
    const ws = FakeWebSocket.instances[0];

    act(() => {
      ws.open();
      vi.advanceTimersByTime(200);
    });
    h.invalidateSpy.mockClear();

    act(() => {
      ws.emitRaw('not json');
      ws.emitRaw(JSON.stringify({ type: 'something-else' }));
      vi.advanceTimersByTime(500);
    });
    expect(h.invalidateSpy).not.toHaveBeenCalled();
  });

  it('does not auto-reconnect after a 4401 close but invalidates the token query so a fresh token reconnects', async () => {
    getNotificationsToken.mockResolvedValue(tokenOkResponse(TOKEN_OK));
    const h = makeHarness();

    h.render();
    await flush();
    expect(FakeWebSocket.instances).toHaveLength(1);
    h.invalidateSpy.mockClear();

    act(() => {
      FakeWebSocket.instances[0].open();
      FakeWebSocket.instances[0].fail(4401);
    });
    // 4401 must mark the token query stale so a fresh token gets
    // refetched and a new handshake is attempted. Key is scoped by
    // authed user id so user A's stale token cannot be served to user B.
    expect(h.invalidateSpy).toHaveBeenCalledWith({ queryKey: ['notificationsToken', 'me'] });

    // No exponential-backoff timer should be running — reconnect is
    // gated on the token effect re-running with a new token.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000);
    });
    expect(FakeWebSocket.instances).toHaveLength(1);
  });

  it('backs off consecutive 4401 closes with no successful message in between (mint/verify secret-mismatch storm guard)', async () => {
    // Simulate the real-world trigger: every mint yields a *different*
    // token (a fresh `jti` guarantees this in production), so each 4401
    // actually flips the effect's `token` dep and a new handshake is
    // attempted — the shape of the storm this backoff guards against
    // (e.g. WS_TOKEN_SECRET unset with no per-process memoization, so
    // mint and verify never agree and every attempt is doomed).
    let mintCount = 0;
    getNotificationsToken.mockImplementation(async () => {
      mintCount += 1;
      return tokenOkResponse({ ...TOKEN_OK, token: `jwt.notifications.${mintCount}` });
    });
    const h = makeHarness();

    h.render();
    await flush();
    expect(FakeWebSocket.instances).toHaveLength(1);

    // First 4401 in this run: invalidated immediately (no backoff) —
    // mirrors the single-4401 test above — and this time the token
    // really changes, so a real reconnect follows.
    act(() => {
      FakeWebSocket.instances[0].open();
      FakeWebSocket.instances[0].fail(4401);
    });
    await flush();
    expect(FakeWebSocket.instances).toHaveLength(2);

    // Second, CONSECUTIVE 4401 — no message ever landed on socket #2.
    // Must NOT invalidate / reconnect immediately.
    h.invalidateSpy.mockClear();
    act(() => {
      FakeWebSocket.instances[1].open();
      FakeWebSocket.instances[1].fail(4401);
    });
    expect(h.invalidateSpy).not.toHaveBeenCalledWith({ queryKey: ['notificationsToken', 'me'] });
    expect(FakeWebSocket.instances).toHaveLength(2);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(999);
    });
    expect(FakeWebSocket.instances).toHaveLength(2);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(50);
    });
    expect(h.invalidateSpy).toHaveBeenCalledWith({ queryKey: ['notificationsToken', 'me'] });
    expect(FakeWebSocket.instances).toHaveLength(3);
  });

  it('resets the consecutive-4401 backoff counter across a logout → same-user relogin', async () => {
    // Regression guard: the session-reset check used to run only after the
    // effect's enabled/token guard passed, so a logout (authedUserId -> null)
    // never touched the tracked session id. Logging back in as the SAME
    // user id then looked like "no change" and the stale attempt count from
    // the old session leaked into the new one.
    let mintCount = 0;
    getNotificationsToken.mockImplementation(async () => {
      mintCount += 1;
      return tokenOkResponse({ ...TOKEN_OK, token: `jwt.notifications.${mintCount}` });
    });
    useAuthMock.mockReturnValue({ user: { id: 'me' } });
    const h = makeHarness();

    const { rerender } = h.render();
    await flush();
    expect(FakeWebSocket.instances).toHaveLength(1);

    // One 4401 bumps the attempt counter to 1 (no message ever arrived to
    // reset it back to 0).
    act(() => {
      FakeWebSocket.instances[0].open();
      FakeWebSocket.instances[0].fail(4401);
    });
    await flush();
    expect(FakeWebSocket.instances).toHaveLength(2);

    // Log out, then log back in as the SAME user id.
    useAuthMock.mockReturnValue({ user: null });
    rerender();
    await flush();

    useAuthMock.mockReturnValue({ user: { id: 'me' } });
    rerender();
    await flush();
    const socketsAfterRelogin = FakeWebSocket.instances.length;
    expect(socketsAfterRelogin).toBeGreaterThan(2);

    h.invalidateSpy.mockClear();
    act(() => {
      FakeWebSocket.instances[socketsAfterRelogin - 1].open();
      FakeWebSocket.instances[socketsAfterRelogin - 1].fail(4401);
    });
    // The first 4401 of the new (relogin) session must invalidate
    // immediately — it must NOT inherit the previous session's attempt
    // count and get backed off instead.
    expect(h.invalidateSpy).toHaveBeenCalledWith({ queryKey: ['notificationsToken', 'me'] });
  });

  it('stops reconnecting after a 4403 close (forbidden)', async () => {
    getNotificationsToken.mockResolvedValue(tokenOkResponse(TOKEN_OK));
    const h = makeHarness();

    h.render();
    await flush();

    act(() => {
      FakeWebSocket.instances[0].open();
      FakeWebSocket.instances[0].fail(4403);
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000);
    });
    expect(FakeWebSocket.instances).toHaveLength(1);
  });

  it('does not refetch the token on a schedule (no proactive reconnect)', async () => {
    // Regression guard: a `refetchInterval` on the token query would
    // re-mint the token every ~30s, which flips the effect's `token`
    // dep, tears the socket down, and re-handshakes — and the
    // `onopen` catch-up invalidate would then fire
    // `notifications.status.$get` on the same cadence, restoring the
    // 30s polling pattern we removed.
    getNotificationsToken.mockResolvedValue(tokenOkResponse(TOKEN_OK));
    const h = makeHarness();

    h.render();
    await flush();
    expect(getNotificationsToken).toHaveBeenCalledTimes(1);
    expect(FakeWebSocket.instances).toHaveLength(1);

    // Hold the socket open and let several minutes of wall time pass.
    // No additional token fetches and no additional sockets should
    // appear — the connection is sticky once handshaken.
    act(() => {
      FakeWebSocket.instances[0].open();
      vi.advanceTimersByTime(200);
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5 * 60_000);
    });
    expect(getNotificationsToken).toHaveBeenCalledTimes(1);
    expect(FakeWebSocket.instances).toHaveLength(1);
  });

  it('backs off (exponentially) after unclean closes', async () => {
    getNotificationsToken.mockResolvedValue(tokenOkResponse(TOKEN_OK));
    const h = makeHarness();

    h.render();
    await flush();
    expect(FakeWebSocket.instances).toHaveLength(1);

    // 1006 + no `changed` message yet → backoff starts at 1s.
    act(() => {
      FakeWebSocket.instances[0].open();
      FakeWebSocket.instances[0].fail(1006);
    });
    await act(async () => {
      // Below the 1s base delay — no reconnect yet.
      await vi.advanceTimersByTimeAsync(500);
    });
    expect(FakeWebSocket.instances).toHaveLength(1);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(600);
    });
    expect(FakeWebSocket.instances).toHaveLength(2);
  });

  it('catches up via invalidate on the *second* open (true reconnect)', async () => {
    // The mirror of "does NOT catch-up on first connect": once a
    // backoff-scheduled reconnect succeeds, we DO want a catch-up
    // invalidate so any change that landed while the socket was down
    // is picked up.
    getNotificationsToken.mockResolvedValue(tokenOkResponse(TOKEN_OK));
    const h = makeHarness();

    h.render();
    await flush();

    act(() => {
      FakeWebSocket.instances[0].open();
      FakeWebSocket.instances[0].fail(1006);
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(15_000);
    });
    expect(FakeWebSocket.instances).toHaveLength(2);
    h.invalidateSpy.mockClear();

    act(() => {
      FakeWebSocket.instances[1].open();
      vi.advanceTimersByTime(200);
    });
    expect(h.invalidateSpy).toHaveBeenCalledWith({ queryKey: notificationKeys.all });
  });

  it('scopes the token cache by authed user id (no cross-user leak after re-login)', async () => {
    // Regression guard: previously the key was `['notificationsToken']`
    // with no user dimension, so logging out and back in as a different
    // user could replay user A's still-cached token through user B's
    // handshake. The key is now `['notificationsToken', authedUserId]`,
    // so a different `useAuth().user.id` forces a fresh fetch.
    getNotificationsToken.mockResolvedValue(tokenOkResponse(TOKEN_OK));
    useAuthMock.mockReturnValue({ user: { id: 'user-a' } });
    const h = makeHarness();

    const { rerender } = h.render();
    await flush();
    expect(getNotificationsToken).toHaveBeenCalledTimes(1);

    // Switch to a different signed-in user — the key changes so a
    // fresh fetch must run.
    useAuthMock.mockReturnValue({ user: { id: 'user-b' } });
    rerender();
    await flush();
    expect(getNotificationsToken).toHaveBeenCalledTimes(2);
  });

  it('does not connect or fetch a token when no user is authed', async () => {
    // Even with `enabled: true` (e.g. a brief mid-logout render), a
    // null user id keeps both the token query and the socket effect
    // idle so we don't blast unauthed requests at `/notifications/token`.
    getNotificationsToken.mockResolvedValue(tokenOkResponse(TOKEN_OK));
    useAuthMock.mockReturnValue({ user: null });
    const h = makeHarness();

    h.render();
    await flush();

    expect(getNotificationsToken).not.toHaveBeenCalled();
    expect(FakeWebSocket.instances).toHaveLength(0);
  });

  it('cancels a pending debounced invalidate when the socket closes with 4401', async () => {
    // Regression guard: the 4401 path used to early-return without
    // clearing `debounceTimer`, so a `changed` tick that fired in the
    // ~milliseconds before close would still run an extra (and now
    // pointless) `invalidateQueries(notificationKeys.all)` 200ms later.
    getNotificationsToken.mockResolvedValue(tokenOkResponse(TOKEN_OK));
    const h = makeHarness();

    h.render();
    await flush();
    const ws = FakeWebSocket.instances[0];

    act(() => {
      ws.open();
      // Queue a debounced invalidate, then immediately tear down with
      // 4401 — the trailing timer must NOT run.
      ws.emitChanged();
      ws.fail(4401);
    });
    h.invalidateSpy.mockClear();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(500);
    });
    expect(h.invalidateSpy).not.toHaveBeenCalledWith({ queryKey: notificationKeys.all });
  });

  it('cancels a pending debounced invalidate when the socket closes with 4403', async () => {
    // Same rationale as the 4401 guard above, for the forbidden path.
    getNotificationsToken.mockResolvedValue(tokenOkResponse(TOKEN_OK));
    const h = makeHarness();

    h.render();
    await flush();
    const ws = FakeWebSocket.instances[0];

    act(() => {
      ws.open();
      ws.emitChanged();
      ws.fail(4403);
    });
    h.invalidateSpy.mockClear();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(500);
    });
    expect(h.invalidateSpy).not.toHaveBeenCalledWith({ queryKey: notificationKeys.all });
  });

  it('retries the token query with exponential backoff on transient failure', async () => {
    // Regression guard: `retry: 1` used to latch the bell into REST-only
    // mode for the rest of the tab lifetime after a single hiccup. We
    // now allow up to 3 retries with capped exponential backoff so a
    // transient blip recovers automatically.
    let attempt = 0;
    getNotificationsToken.mockImplementation(async () => {
      attempt += 1;
      if (attempt < 3) throw new Error('flaky');
      return tokenOkResponse(TOKEN_OK);
    });
    const h = makeHarness();

    h.render();
    await flush();
    expect(getNotificationsToken).toHaveBeenCalledTimes(1);

    // Drain react-query's retry timers (1s, then 2s — capped at 15s).
    await act(async () => {
      await vi.advanceTimersByTimeAsync(20_000);
    });
    expect(getNotificationsToken).toHaveBeenCalledTimes(3);
    expect(FakeWebSocket.instances).toHaveLength(1);
  });
});

describe('resolveNotificationsUrl', () => {
  const originalCollab = process.env.NEXT_PUBLIC_COLLAB_URL;
  const originalApi = process.env.NEXT_PUBLIC_API_URL;

  afterEach(() => {
    if (originalCollab === undefined) delete process.env.NEXT_PUBLIC_COLLAB_URL;
    else process.env.NEXT_PUBLIC_COLLAB_URL = originalCollab;
    if (originalApi === undefined) delete process.env.NEXT_PUBLIC_API_URL;
    else process.env.NEXT_PUBLIC_API_URL = originalApi;
  });

  it('derives from window.location when neither env var is set (same-origin image default)', () => {
    // feature-web-image-runtime-config: no baked URL → the distributed image
    // dials its own origin. jsdom serves the suite from http://localhost:3000.
    delete process.env.NEXT_PUBLIC_COLLAB_URL;
    delete process.env.NEXT_PUBLIC_API_URL;
    expect(resolveNotificationsUrl()).toBe('ws://localhost:3000/notifications');
  });

  it('uses NEXT_PUBLIC_API_URL as-is when set (dev / Vercel) — NOT window.location', () => {
    // Dev (api :4301) and Vercel builds bake NEXT_PUBLIC_API_URL; the WS must
    // target it, not the Next dev server origin whose HTTP rewrites drop the
    // WS upgrade.
    delete process.env.NEXT_PUBLIC_COLLAB_URL;
    process.env.NEXT_PUBLIC_API_URL = 'https://api.example.com';
    expect(resolveNotificationsUrl()).toBe('wss://api.example.com/notifications');
  });

  it('strips a trailing slash on NEXT_PUBLIC_API_URL so the URL is never `//notifications`', () => {
    // Regression guard: a trailing `/` on the api base used to produce
    // `wss://api.example.com//notifications`, which most proxies
    // rewrite or 404.
    delete process.env.NEXT_PUBLIC_COLLAB_URL;
    process.env.NEXT_PUBLIC_API_URL = 'https://api.example.com/';
    expect(resolveNotificationsUrl()).toBe('wss://api.example.com/notifications');
  });

  it('strips a `/collab` suffix on NEXT_PUBLIC_COLLAB_URL (with and without trailing slash)', () => {
    process.env.NEXT_PUBLIC_COLLAB_URL = 'https://api.example.com/collab';
    expect(resolveNotificationsUrl()).toBe('wss://api.example.com/notifications');

    process.env.NEXT_PUBLIC_COLLAB_URL = 'https://api.example.com/collab/';
    expect(resolveNotificationsUrl()).toBe('wss://api.example.com/notifications');
  });

  it('strips a `/notifications` suffix on NEXT_PUBLIC_COLLAB_URL so operators can point all three namespaces at the same env', () => {
    // Regression guard: if an operator sets NEXT_PUBLIC_COLLAB_URL to
    // `https://api.example.com/notifications` thinking it's a per-namespace
    // base, we'd produce `wss://.../notifications/notifications` —
    // strip the suffix so the URL still resolves to one canonical path.
    process.env.NEXT_PUBLIC_COLLAB_URL = 'https://api.example.com/notifications';
    expect(resolveNotificationsUrl()).toBe('wss://api.example.com/notifications');

    process.env.NEXT_PUBLIC_COLLAB_URL = 'https://api.example.com/notifications/';
    expect(resolveNotificationsUrl()).toBe('wss://api.example.com/notifications');
  });
});
