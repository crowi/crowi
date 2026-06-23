import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, cleanup, act, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createElement, type PropsWithChildren } from 'react';
import * as Y from 'yjs';

/**
 * editor-preview-reliability (round 2) `useCollabSession` lifecycle tests:
 *   - D1: an established connection persists across the token-TTL window —
 *     no provider rebuild / editor remount while connected (the proactive
 *     wsToken refetch was removed).
 *   - D2: the bounded auth-failed recovery re-arms its backoff, escalates to
 *     a terminal `authRecoveryExhausted` when the budget is spent, and
 *     clears the flag when the session recovers via any path.
 */

const { getYjsToken, FakeProvider, providerInstances } = vi.hoisted(() => {
  interface Instance {
    document: Y.Doc;
    config: Record<string, unknown> & {
      onStatus?: (e: { status: string }) => void;
      onSynced?: (e: { state: boolean }) => void;
      onAuthenticationFailed?: () => void;
    };
    destroy: () => void;
  }
  const instances: Instance[] = [];
  class FakeProvider {
    document: Y.Doc;
    awareness: object;
    config: Instance['config'];
    destroy = vi.fn();
    sendStateless = vi.fn();
    constructor(config: Instance['config']) {
      this.config = config;
      this.document = config.document as Y.Doc;
      this.awareness = { setLocalState: vi.fn(), setLocalStateField: vi.fn(), getStates: () => new Map(), on: vi.fn(), off: vi.fn() };
      instances.push({ document: this.document, config, destroy: this.destroy });
    }
  }
  return { getYjsToken: vi.fn(), FakeProvider, providerInstances: instances };
});

vi.mock('@/lib/api-client', () => ({
  apiClientV2: { pages: { ':id': { 'yjs-token': { $get: getYjsToken } } } },
  apiV2BaseUrl: () => 'http://localhost:4301/api/v2',
}));

vi.mock('@/lib/use-auth', () => ({
  useAuth: () => ({ user: null, isLoading: false, isAuthenticated: false, logout: vi.fn(), refetch: vi.fn() }),
}));

vi.mock('@hocuspocus/provider', () => ({
  HocuspocusProvider: FakeProvider,
  WebSocketStatus: { Connecting: 'connecting', Connected: 'connected', Disconnected: 'disconnected' },
}));

import { useCollabSession } from './CollaborativeMarkdownEditor';

afterEach(() => {
  cleanup();
  providerInstances.length = 0;
  getYjsToken.mockReset();
  vi.useRealTimers();
});

const tokenOk = (wsToken: string) => ({
  ok: true as const,
  status: 200,
  json: () =>
    Promise.resolve({
      wsToken,
      pageId: 'page-1',
      // A short 5-minute TTL — the point of D1 is that we do NOT refetch
      // around it while connected.
      expiresAt: new Date(Date.now() + 5 * 60 * 1000).toISOString(),
      readonly: false,
    }),
});

function makeWrapper() {
  const client = new QueryClient({ defaultOptions: { queries: { retryDelay: 0, gcTime: 0 } } });
  return function Wrapper({ children }: PropsWithChildren) {
    return createElement(QueryClientProvider, { client }, children);
  };
}

describe('useCollabSession lifecycle (D1 / D2)', () => {
  beforeEach(() => {
    getYjsToken.mockResolvedValue(tokenOk('jwt.first'));
  });

  it('D1: stays connected across the token-TTL window WITHOUT rebuilding the provider (no editor remount)', async () => {
    vi.useFakeTimers();
    const { result } = renderHook(() => useCollabSession('page-1'), { wrapper: makeWrapper() });

    // Let the first token resolve + the provider build.
    await vi.waitFor(() => expect(providerInstances.length).toBe(1));
    act(() => {
      providerInstances[0]?.config.onStatus?.({ status: 'connected' });
      providerInstances[0]?.config.onSynced?.({ state: true });
    });
    expect(result.current.hasEverSynced).toBe(true);
    expect(getYjsToken).toHaveBeenCalledTimes(1);

    // Advance well past the 5-minute TTL while connected. With the proactive
    // refetchInterval removed (D1), no new token is fetched and the single
    // provider is never torn down → the editor never remounts mid-edit.
    await act(async () => {
      vi.advanceTimersByTime(10 * 60 * 1000);
      await Promise.resolve();
    });

    expect(getYjsToken).toHaveBeenCalledTimes(1);
    expect(providerInstances.length).toBe(1);
    expect(providerInstances[0]?.destroy).not.toHaveBeenCalled();
    expect(result.current.hasEverSynced).toBe(true);
  });

  it('D2: auth-failed re-arms the bounded backoff, escalates to terminal, then clears ONLY on a confirmed sync', async () => {
    // The first token resolves (provider #1 built). Every subsequent refetch
    // REJECTS — so no new provider is built and the single provider stays in
    // auth-failed; the backoff self-reschedules until the budget is spent and
    // we escalate to terminal. Real timers (the backoff is 1s+2s+4s = 7s) with
    // a generous test timeout keeps the async react-query + setTimeout
    // interleaving deterministic.
    getYjsToken.mockResolvedValueOnce(tokenOk('jwt.first')).mockRejectedValue(new Error('still rejected'));

    const { result } = renderHook(() => useCollabSession('page-1'), { wrapper: makeWrapper() });
    await waitFor(() => expect(providerInstances.length).toBe(1));

    // First sync so hasEverSynced latches (the editor is mounted) before the
    // failure.
    act(() => {
      providerInstances[0]?.config.onStatus?.({ status: 'connected' });
      providerInstances[0]?.config.onSynced?.({ state: true });
    });
    expect(result.current.hasEverSynced).toBe(true);

    // Drive the provider into the terminal auth-failed state.
    act(() => {
      providerInstances[0]?.config.onAuthenticationFailed?.();
    });
    expect(result.current.status).toBe('auth-failed');
    expect(result.current.authRecoveryExhausted).toBe(false);
    // D1b — the mount gate stays up during recovery (editor mounted,
    // "reconnecting…"); it is NOT cleared on auth-failed.
    expect(result.current.hasEverSynced).toBe(true);

    // The 3-step backoff self-reschedules; each refetch rejects, status stays
    // auth-failed, and after the budget is spent we escalate to terminal. The
    // attempt counter survives the oscillation (it lives in a ref), so the
    // budget genuinely drains instead of resetting on every transient connect.
    await waitFor(() => expect(result.current.authRecoveryExhausted).toBe(true), { timeout: 15000 });
    // No new provider was built on the rejected refetches.
    expect(providerInstances.length).toBe(1);
    // D1b — once terminal, the mount gate is masked off (editor flips to the
    // terminal "session expired" state).
    expect(result.current.hasEverSynced).toBe(false);

    // A transient connect WITHOUT a sync must NOT clear the terminal flag —
    // the rebuilt provider could immediately auth-fail again; only a confirmed
    // sync proves recovery.
    act(() => {
      providerInstances[0]?.config.onStatus?.({ status: 'connected' });
    });
    expect(result.current.authRecoveryExhausted).toBe(true);

    // A CONFIRMED sync (SyncStep2) clears the terminal flag, restores the
    // mount gate, and re-arms for any future episode.
    act(() => {
      providerInstances[0]?.config.onSynced?.({ state: true });
    });
    await waitFor(() => expect(result.current.authRecoveryExhausted).toBe(false));
    expect(result.current.hasEverSynced).toBe(true);
  }, 20000);
});
