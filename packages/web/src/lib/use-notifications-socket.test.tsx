import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { PropsWithChildren } from 'react';
import { createElement } from 'react';

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

import { useNotificationsSocket } from './use-notifications-socket';
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
      // Open already schedules a catch-up invalidate; advance past the
      // debounce window so it lands before we start counting again.
      vi.advanceTimersByTime(200);
    });
    expect(h.invalidateSpy).toHaveBeenCalledWith({ queryKey: notificationKeys.all });
    h.invalidateSpy.mockClear();

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

  it('stops reconnecting after a 4401 close (token expired)', async () => {
    getNotificationsToken.mockResolvedValue(tokenOkResponse(TOKEN_OK));
    const h = makeHarness();

    h.render();
    await flush();
    expect(FakeWebSocket.instances).toHaveLength(1);

    act(() => {
      FakeWebSocket.instances[0].open();
      FakeWebSocket.instances[0].fail(4401);
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000);
    });
    expect(FakeWebSocket.instances).toHaveLength(1);
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
});
