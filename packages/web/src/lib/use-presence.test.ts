import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { PropsWithChildren } from 'react';
import { createElement } from 'react';
import type { PresenceViewer } from '@crowi/api-contract';

// Mock `apiClient` so the token query reads our fake endpoint.
const { getPresenceToken } = vi.hoisted(() => ({ getPresenceToken: vi.fn() }));
vi.mock('./api-client', () => ({
  apiClient: { presence: { getPresenceToken } },
}));

import { usePresence } from './use-presence';

/**
 * Minimal fake WebSocket — captures instances so tests can drive
 * `onopen` / `onmessage` / `onclose` explicitly. The presence hook
 * only ever uses the `on*` handler properties and `send` / `close`.
 */
class FakeWebSocket {
  static OPEN = 1;
  static instances: FakeWebSocket[] = [];

  url: string;
  readyState = 0;
  sent: string[] = [];
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

  send(payload: string) {
    this.sent.push(payload);
  }

  // Test helpers.
  open() {
    this.readyState = FakeWebSocket.OPEN;
    this.onopen?.();
  }
  emit(viewers: PresenceViewer[]) {
    this.onmessage?.({ data: JSON.stringify({ type: 'viewers', viewers }) });
  }
  emitRaw(data: unknown) {
    this.onmessage?.({ data });
  }
  fail(code = 1006) {
    this.readyState = 3;
    this.onclose?.({ code });
  }
}

function viewer(userId: string, overrides: Partial<PresenceViewer> = {}): PresenceViewer {
  return {
    userId,
    username: userId,
    displayName: `User ${userId}`,
    avatarUrl: null,
    isEditing: false,
    joinedAt: 1_000,
    ...overrides,
  };
}

function makeWrapper() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  return function Wrapper({ children }: PropsWithChildren) {
    return createElement(QueryClientProvider, { client }, children);
  };
}

/**
 * Drain pending microtasks (the token queryFn promise + react-query's
 * commit) under fake timers. `advanceTimersByTimeAsync(0)` yields to
 * the microtask queue while keeping the deterministic fake clock, so
 * the token query resolves and the connect effect fires the WebSocket.
 */
async function flush() {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0);
  });
}

const TOKEN_OK = {
  token: 'jwt.presence',
  pageId: 'page-1',
  selfUserId: 'me',
  expiresAt: new Date(Date.now() + 5 * 60 * 1000).toISOString(),
};

beforeEach(() => {
  vi.useFakeTimers();
  getPresenceToken.mockReset();
  FakeWebSocket.instances.length = 0;
  vi.stubGlobal('WebSocket', FakeWebSocket);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('usePresence', () => {
  it('does not open a WebSocket when pageId is null', () => {
    renderHook(() => usePresence(null), { wrapper: makeWrapper() });
    expect(FakeWebSocket.instances).toHaveLength(0);
  });

  it('fetches a token then connects to /presence/<pageId> with it', async () => {
    getPresenceToken.mockResolvedValue({ status: 200, body: TOKEN_OK });

    const { result } = renderHook(() => usePresence('page-1'), { wrapper: makeWrapper() });

    await flush();
    expect(FakeWebSocket.instances).toHaveLength(1);
    const ws = FakeWebSocket.instances[0];
    expect(ws.url).toContain('/presence/page-1');
    expect(ws.url).toContain('token=jwt.presence');
    expect(result.current.selfUserId).toBe('me');
  });

  it('reports connected status and sends a heartbeat on open and every 15s', async () => {
    getPresenceToken.mockResolvedValue({ status: 200, body: TOKEN_OK });

    const { result } = renderHook(() => usePresence('page-1'), { wrapper: makeWrapper() });
    await flush();
    expect(FakeWebSocket.instances).toHaveLength(1);
    const ws = FakeWebSocket.instances[0];

    act(() => {
      ws.open();
    });
    expect(result.current.status).toBe('connected');
    // One heartbeat fired immediately on open.
    expect(ws.sent).toEqual([JSON.stringify({ type: 'heartbeat' })]);

    act(() => {
      vi.advanceTimersByTime(15_000);
    });
    expect(ws.sent).toHaveLength(2);
  });

  it('surfaces viewers from a broadcast after the anti-flicker delay', async () => {
    getPresenceToken.mockResolvedValue({ status: 200, body: TOKEN_OK });

    const { result } = renderHook(() => usePresence('page-1'), { wrapper: makeWrapper() });
    await flush();
    expect(FakeWebSocket.instances).toHaveLength(1);
    const ws = FakeWebSocket.instances[0];

    act(() => {
      ws.open();
      ws.emit([viewer('me'), viewer('alice')]);
    });

    // `me` shows immediately; `alice` waits out the 3s grace period.
    expect(result.current.viewers.map((v) => v.userId)).toEqual(['me']);

    act(() => {
      vi.advanceTimersByTime(3_000);
    });
    expect(result.current.viewers.map((v) => v.userId)).toEqual(['me', 'alice']);
  });

  it('drops a viewer that leaves within the 3s anti-flicker window', async () => {
    getPresenceToken.mockResolvedValue({ status: 200, body: TOKEN_OK });

    const { result } = renderHook(() => usePresence('page-1'), { wrapper: makeWrapper() });
    await flush();
    expect(FakeWebSocket.instances).toHaveLength(1);
    const ws = FakeWebSocket.instances[0];

    act(() => {
      ws.open();
      ws.emit([viewer('me'), viewer('alice')]);
    });
    act(() => {
      vi.advanceTimersByTime(2_000);
      // Alice leaves before her admission timer fires.
      ws.emit([viewer('me')]);
      vi.advanceTimersByTime(5_000);
    });
    expect(result.current.viewers.map((v) => v.userId)).toEqual(['me']);
  });

  it('ignores malformed and non-JSON frames', async () => {
    getPresenceToken.mockResolvedValue({ status: 200, body: TOKEN_OK });

    const { result } = renderHook(() => usePresence('page-1'), { wrapper: makeWrapper() });
    await flush();
    expect(FakeWebSocket.instances).toHaveLength(1);
    const ws = FakeWebSocket.instances[0];

    act(() => {
      ws.open();
      ws.emitRaw('not json');
      ws.emitRaw(JSON.stringify({ type: 'something-else' }));
    });
    expect(result.current.viewers).toEqual([]);
    expect(result.current.status).toBe('connected');
  });

  it('reports error status when the WebSocket closes uncleanly', async () => {
    getPresenceToken.mockResolvedValue({ status: 200, body: TOKEN_OK });

    const { result } = renderHook(() => usePresence('page-1'), { wrapper: makeWrapper() });
    await flush();
    expect(FakeWebSocket.instances).toHaveLength(1);
    const ws = FakeWebSocket.instances[0];

    act(() => {
      ws.open();
      ws.fail();
    });
    expect(result.current.status).toBe('error');
  });

  it('reconnects after an unclean close but not after a 4403 (permission revoked)', async () => {
    getPresenceToken.mockResolvedValue({ status: 200, body: TOKEN_OK });

    const { result } = renderHook(() => usePresence('page-1'), { wrapper: makeWrapper() });
    await flush();
    expect(FakeWebSocket.instances).toHaveLength(1);

    // Unclean close → a reconnect is scheduled.
    act(() => {
      FakeWebSocket.instances[0].open();
      FakeWebSocket.instances[0].fail(1006);
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(15_000);
    });
    expect(FakeWebSocket.instances).toHaveLength(2);

    // 4403 = read grant revoked → the client must stop reconnecting.
    act(() => {
      FakeWebSocket.instances[1].open();
      FakeWebSocket.instances[1].fail(4403);
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000);
    });
    expect(FakeWebSocket.instances).toHaveLength(2);
    expect(result.current.status).toBe('error');
  });

  it('reports error status when the token request fails (no WebSocket opened)', async () => {
    getPresenceToken.mockResolvedValue({ status: 500, body: { error: { message: 'boom' } } });

    const { result } = renderHook(() => usePresence('page-1'), { wrapper: makeWrapper() });

    // The token query is configured `retry: 1`; advance past the retry
    // backoff so react-query reaches its terminal error state.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000);
    });
    expect(result.current.status).toBe('error');
    expect(FakeWebSocket.instances).toHaveLength(0);
  });
});
