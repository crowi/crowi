import type { PresenceViewer } from '@crowi/api-contract';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, renderHook } from '@testing-library/react';
import type { PropsWithChildren } from 'react';
import { createElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Mock `apiClientV2` so the token query reads our fake `pages[':id']
// ['presence-token'].$get`. RFC-0006 Batch 5 switched the hook from
// ts-rest's `apiClient.presence.getPresenceToken` to `apiClientV2`'s
// Response-shaped fetch call.
const { getPresenceToken } = vi.hoisted(() => ({ getPresenceToken: vi.fn() }));
vi.mock('./api-client', () => ({
  apiClientV2: {
    pages: {
      ':id': {
        'presence-token': { $get: getPresenceToken },
      },
    },
  },
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

/**
 * `Response`-shaped helpers for the `apiClientV2` mock. Batch 5 switched
 * the hook to read `response.ok` + `response.json()` directly (instead
 * of the ts-rest `{ status, body }` envelope), so every mock here
 * returns the shape the real `fetch` would return.
 */
function tokenOkResponse<T>(body: T): { ok: true; status: number; json: () => Promise<T> } {
  return { ok: true, status: 200, json: () => Promise.resolve(body) };
}
function tokenErrorResponse(status: number, body: unknown): { ok: false; status: number; json: () => Promise<unknown> } {
  return { ok: false, status, json: () => Promise.resolve(body) };
}

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
    getPresenceToken.mockResolvedValue(tokenOkResponse(TOKEN_OK));

    const { result } = renderHook(() => usePresence('page-1'), { wrapper: makeWrapper() });

    await flush();
    expect(FakeWebSocket.instances).toHaveLength(1);
    const ws = FakeWebSocket.instances[0];
    expect(ws.url).toContain('/presence/page-1');
    expect(ws.url).toContain('token=jwt.presence');
    expect(result.current.selfUserId).toBe('me');
  });

  it('reports connected status and sends a heartbeat on open and every 15s', async () => {
    getPresenceToken.mockResolvedValue(tokenOkResponse(TOKEN_OK));

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

  it('reports connecting -> connected -> error -> connecting -> connected across an unclean-close reconnect', async () => {
    getPresenceToken.mockResolvedValue(tokenOkResponse(TOKEN_OK));

    const { result } = renderHook(() => usePresence('page-1'), { wrapper: makeWrapper() });
    // Before the token resolves the hook has not even attempted a
    // connection yet, but the status still starts at 'connecting'.
    expect(result.current.status).toBe('connecting');

    await flush();
    expect(FakeWebSocket.instances).toHaveLength(1);
    const ws = FakeWebSocket.instances[0];

    act(() => {
      ws.open();
    });
    expect(result.current.status).toBe('connected');

    // An unclean close flips to 'error' immediately...
    act(() => {
      ws.fail(1006);
    });
    expect(result.current.status).toBe('error');

    // ...and back to 'connecting' as soon as the backoff-scheduled retry
    // actually opens a new connection attempt — NOT stuck on 'error' for
    // the whole backoff window, and not skipping straight to 'connected'
    // without visiting 'connecting' first.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(999);
    });
    expect(FakeWebSocket.instances).toHaveLength(1);
    expect(result.current.status).toBe('error');
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    expect(FakeWebSocket.instances).toHaveLength(2);
    expect(result.current.status).toBe('connecting');

    act(() => {
      FakeWebSocket.instances[1].open();
    });
    expect(result.current.status).toBe('connected');
  });

  it('surfaces viewers from a broadcast after the anti-flicker delay', async () => {
    getPresenceToken.mockResolvedValue(tokenOkResponse(TOKEN_OK));

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
    getPresenceToken.mockResolvedValue(tokenOkResponse(TOKEN_OK));

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
    getPresenceToken.mockResolvedValue(tokenOkResponse(TOKEN_OK));

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

  it('invokes onPageUpdated for another user save AND for the caller own save (feature-live-page-sync-reconcile: self/other silencing moved to the consumer)', async () => {
    getPresenceToken.mockResolvedValue(tokenOkResponse(TOKEN_OK));
    const onPageUpdated = vi.fn();

    const { result } = renderHook(() => usePresence('page-1', { onPageUpdated }), { wrapper: makeWrapper() });
    await flush();
    const ws = FakeWebSocket.instances[0];

    const fromBob = { type: 'page-updated', pageId: 'page-1', revisionId: 'rev-9', editorUserId: 'bob', editorDisplayName: 'Bob' };
    act(() => {
      ws.open();
      ws.emitRaw(JSON.stringify(fromBob));
    });
    expect(onPageUpdated).toHaveBeenCalledTimes(1);
    expect(onPageUpdated).toHaveBeenCalledWith(fromBob);
    // A page-updated frame never touches the viewer list.
    expect(result.current.viewers).toEqual([]);

    // The caller's own save (editorUserId === selfUserId 'me') now ALSO
    // reaches the callback — a self save from another tab/device must
    // still swap the cache (silently); only the banner is suppressed,
    // and that decision lives in the consumer, which alone knows the
    // read-old banner state.
    act(() => {
      ws.emitRaw(JSON.stringify({ type: 'page-updated', pageId: 'page-1', revisionId: 'rev-10', editorUserId: 'me', editorDisplayName: 'Me' }));
    });
    expect(onPageUpdated).toHaveBeenCalledTimes(2);
  });

  it('increments pageUpdatedSeq for every page-updated frame (self included), read live via .current — not a frozen snapshot', async () => {
    getPresenceToken.mockResolvedValue(tokenOkResponse(TOKEN_OK));

    const { result } = renderHook(() => usePresence('page-1'), { wrapper: makeWrapper() });
    await flush();
    const ws = FakeWebSocket.instances[0];

    // Contract: a RefObject, not a plain number — the reconcile consumer
    // relies on reading `.current` at two different points in time.
    expect(result.current.pageUpdatedSeq).toHaveProperty('current');
    const seqRef = result.current.pageUpdatedSeq;
    expect(seqRef.current).toBe(0);

    act(() => {
      ws.open();
      ws.emitRaw(JSON.stringify({ type: 'page-updated', pageId: 'page-1', revisionId: 'rev-1', editorUserId: 'bob', editorDisplayName: 'Bob' }));
    });
    expect(seqRef.current).toBe(1);

    // A self save also increments the counter (no self-suppression here).
    act(() => {
      ws.emitRaw(JSON.stringify({ type: 'page-updated', pageId: 'page-1', revisionId: 'rev-2', editorUserId: 'me', editorDisplayName: 'Me' }));
    });
    expect(seqRef.current).toBe(2);
    // The SAME ref object identity is returned across renders/re-reads —
    // a caller that read it once and cached the object still observes
    // the live mutation via `.current`.
    expect(result.current.pageUpdatedSeq).toBe(seqRef);
  });

  it('fires onReconnected once per connection epoch, after the FIRST viewers broadcast (not onopen)', async () => {
    getPresenceToken.mockResolvedValue(tokenOkResponse(TOKEN_OK));
    const onReconnected = vi.fn();

    renderHook(() => usePresence('page-1', { onReconnected }), { wrapper: makeWrapper() });
    await flush();
    const ws = FakeWebSocket.instances[0];

    act(() => {
      ws.open();
    });
    // onopen alone must NOT fire it — the server may still reject before
    // ever sending a frame (e.g. a bad token).
    expect(onReconnected).not.toHaveBeenCalled();

    act(() => {
      ws.emit([viewer('me')]);
    });
    expect(onReconnected).toHaveBeenCalledTimes(1);

    // A second viewers broadcast in the SAME epoch does not re-fire it.
    act(() => {
      ws.emit([viewer('me'), viewer('alice')]);
    });
    expect(onReconnected).toHaveBeenCalledTimes(1);

    // Reconnecting (a new epoch) fires it again, once, after ITS first
    // viewers broadcast.
    act(() => {
      ws.fail(1006);
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(15_000);
    });
    const ws2 = FakeWebSocket.instances[1];
    act(() => {
      ws2.open();
    });
    expect(onReconnected).toHaveBeenCalledTimes(1);
    act(() => {
      ws2.emit([viewer('me')]);
    });
    expect(onReconnected).toHaveBeenCalledTimes(2);
  });

  it('never fires onReconnected when the connection never receives a viewers broadcast (presence.join() failure, spec §11 barrier is best-effort)', async () => {
    getPresenceToken.mockResolvedValue(tokenOkResponse(TOKEN_OK));
    const onReconnected = vi.fn();

    renderHook(() => usePresence('page-1', { onReconnected }), { wrapper: makeWrapper() });
    await flush();
    const ws = FakeWebSocket.instances[0];

    // The transport handshake completes (`onopen`) — this alone must never
    // fire the barrier (asserted by the sibling test above). Here the
    // server-side `presence.join()` call itself is assumed to have failed
    // (e.g. Redis hSet down): no `viewers` broadcast for THIS connection
    // ever arrives, however long the tab stays connected — heartbeats keep
    // firing (the socket looks alive from the client's perspective) but
    // `onReconnected` must never fire for this epoch. The periodic
    // 3-minute backstop (page-view.tsx, not this hook) is the fallback
    // that recovers this gap — see page-view-reconcile.test.tsx's
    // "reconnect barrier missing -> periodic backstop recovers" test.
    act(() => {
      ws.open();
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5 * 60_000); // several heartbeat cycles, still nothing
    });
    expect(onReconnected).not.toHaveBeenCalled();
  });

  it('fires onAccessRevoked only for a 4403 close, not 4401', async () => {
    getPresenceToken.mockResolvedValue(tokenOkResponse(TOKEN_OK));
    const onAccessRevoked = vi.fn();

    renderHook(() => usePresence('page-1', { onAccessRevoked }), { wrapper: makeWrapper() });
    await flush();
    const ws = FakeWebSocket.instances[0];

    act(() => {
      ws.open();
      ws.fail(4401);
    });
    expect(onAccessRevoked).not.toHaveBeenCalled();

    // A fresh connection closed with 4403 fires it exactly once.
    getPresenceToken.mockResolvedValue(tokenOkResponse({ ...TOKEN_OK, token: 'jwt.presence.2' }));
    renderHook(() => usePresence('page-2', { onAccessRevoked }), { wrapper: makeWrapper() });
    await flush();
    const ws2 = FakeWebSocket.instances[FakeWebSocket.instances.length - 1];
    act(() => {
      ws2.open();
      ws2.fail(4403);
    });
    expect(onAccessRevoked).toHaveBeenCalledTimes(1);
  });

  it('invokes onCommentChanged for another user added comment and suppresses the caller own', async () => {
    getPresenceToken.mockResolvedValue(tokenOkResponse(TOKEN_OK));
    const onCommentChanged = vi.fn();

    const { result } = renderHook(() => usePresence('page-1', { onCommentChanged }), { wrapper: makeWrapper() });
    await flush();
    const ws = FakeWebSocket.instances[0];

    const fromBob = { type: 'comment-changed', pageId: 'page-1', changeType: 'added', commentId: 'c-1', actorUserId: 'bob' };
    act(() => {
      ws.open();
      ws.emitRaw(JSON.stringify(fromBob));
    });
    expect(onCommentChanged).toHaveBeenCalledTimes(1);
    expect(onCommentChanged).toHaveBeenCalledWith(fromBob);
    // A comment-changed frame never touches the viewer list.
    expect(result.current.viewers).toEqual([]);

    // The caller's own added comment (actorUserId === selfUserId 'me') is suppressed.
    act(() => {
      ws.emitRaw(JSON.stringify({ type: 'comment-changed', pageId: 'page-1', changeType: 'added', commentId: 'c-2', actorUserId: 'me' }));
    });
    expect(onCommentChanged).toHaveBeenCalledTimes(1);
  });

  it('always invokes onCommentChanged for a removed comment (no actorUserId, even the caller own)', async () => {
    getPresenceToken.mockResolvedValue(tokenOkResponse(TOKEN_OK));
    const onCommentChanged = vi.fn();

    renderHook(() => usePresence('page-1', { onCommentChanged }), { wrapper: makeWrapper() });
    await flush();
    const ws = FakeWebSocket.instances[0];

    act(() => {
      ws.open();
      // Removal carries no actorUserId — it is never self-suppressed.
      ws.emitRaw(JSON.stringify({ type: 'comment-changed', pageId: 'page-1', changeType: 'removed', commentId: 'c-1' }));
    });
    expect(onCommentChanged).toHaveBeenCalledTimes(1);
    expect(onCommentChanged).toHaveBeenCalledWith({ type: 'comment-changed', pageId: 'page-1', changeType: 'removed', commentId: 'c-1' });
  });

  it('reports error status when the WebSocket closes uncleanly', async () => {
    getPresenceToken.mockResolvedValue(tokenOkResponse(TOKEN_OK));

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
    getPresenceToken.mockResolvedValue(tokenOkResponse(TOKEN_OK));

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

  it('stops reconnecting after a 4401 (expired token) close', async () => {
    getPresenceToken.mockResolvedValue(tokenOkResponse(TOKEN_OK));

    renderHook(() => usePresence('page-1'), { wrapper: makeWrapper() });
    await flush();
    expect(FakeWebSocket.instances).toHaveLength(1);

    // 4401 = the presence token is expired / invalid. Reconnecting with
    // the same token just loops — the client must stop.
    act(() => {
      FakeWebSocket.instances[0].open();
      FakeWebSocket.instances[0].fail(4401);
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000);
    });
    expect(FakeWebSocket.instances).toHaveLength(1);
  });

  it('backs off across handshake-then-close cycles (no flat 1s reconnect loop)', async () => {
    getPresenceToken.mockResolvedValue(tokenOkResponse(TOKEN_OK));

    renderHook(() => usePresence('page-1'), { wrapper: makeWrapper() });
    await flush();

    // Cycle 1: the handshake completes (`open`) then the socket closes
    // uncleanly before any `viewers` frame — the first reconnect fires
    // after the ~1s backoff floor.
    act(() => {
      FakeWebSocket.instances[0].open();
      FakeWebSocket.instances[0].fail(1006);
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_000);
    });
    expect(FakeWebSocket.instances).toHaveLength(2);

    // Cycle 2: same again. The backoff must have grown to ~2s — a
    // reconnect must NOT fire within another 1s. (It did when `onopen`
    // reset the attempt counter, pinning the loop at a flat 1s.)
    act(() => {
      FakeWebSocket.instances[1].open();
      FakeWebSocket.instances[1].fail(1006);
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_000);
    });
    expect(FakeWebSocket.instances).toHaveLength(2);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_000);
    });
    expect(FakeWebSocket.instances).toHaveLength(3);
  });

  it('reports error status when the token request fails (no WebSocket opened)', async () => {
    getPresenceToken.mockResolvedValue(tokenErrorResponse(500, { error: { message: 'boom' } }));

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
