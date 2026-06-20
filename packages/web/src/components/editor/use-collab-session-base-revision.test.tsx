import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, cleanup, act, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createElement, type PropsWithChildren } from 'react';
import * as Y from 'yjs';

/**
 * editor-preview-reliability H1 regression — `useCollabSession` pins the
 * edit-base revision ONCE (session start) and advances it ONLY on the
 * client's own `crowi:save-ok`. It must NOT re-pin to the *latest*
 * revision when the ~5-min wsToken refetch returns a newer
 * `currentRevision` (that silently disabled the optimistic lock and let
 * co-editing false-CONFLICT in the pre-fix code).
 */

const { getYjsToken, FakeProvider, providerInstances } = vi.hoisted(() => {
  interface Instance {
    document: Y.Doc;
    config: Record<string, unknown> & {
      onStatus?: (e: { status: string }) => void;
      onSynced?: (e: { state: boolean }) => void;
    };
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
      instances.push({ document: this.document, config });
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
});

const tokenOk = (currentRevision: string | null) => ({
  ok: true as const,
  status: 200,
  json: () =>
    Promise.resolve({
      wsToken: 'jwt.test.token',
      pageId: 'page-1',
      expiresAt: new Date(Date.now() + 5 * 60 * 1000).toISOString(),
      readonly: false,
      currentRevision,
    }),
});

function makeWrapper() {
  const client = new QueryClient({ defaultOptions: { queries: { retryDelay: 0, gcTime: 0 } } });
  return function Wrapper({ children }: PropsWithChildren) {
    return createElement(QueryClientProvider, { client }, children);
  };
}

describe('useCollabSession base-revision (H1)', () => {
  beforeEach(() => {
    getYjsToken.mockResolvedValue(tokenOk('rev-1'));
  });

  it('pins baseRevisionId to the FIRST token currentRevision and does not re-pin on refetch', async () => {
    // First fetch → rev-1; a later refetch returns rev-2 (another save
    // landed). The base must stay rev-1 (the revision this doc descends
    // from), not jump to rev-2 — otherwise the lock never fires.
    getYjsToken.mockResolvedValueOnce(tokenOk('rev-1')).mockResolvedValue(tokenOk('rev-2'));

    const { result } = renderHook(() => useCollabSession('page-1'), { wrapper: makeWrapper() });

    await waitFor(() => expect(result.current.baseRevisionId).toBe('rev-1'));

    // Simulate the dynamic refetch returning a newer currentRevision.
    act(() => {
      providerInstances[0]?.config.onStatus?.({ status: 'connected' });
    });
    // Even after the cache could be updated by a refetch, the pinned base
    // stays rev-1 (anchored once).
    await new Promise((r) => setTimeout(r, 10));
    expect(result.current.baseRevisionId).toBe('rev-1');
  });

  it("advances baseRevisionId only via advanceBaseRevision (this client's own save-ok)", async () => {
    const { result } = renderHook(() => useCollabSession('page-1'), { wrapper: makeWrapper() });
    await waitFor(() => expect(result.current.baseRevisionId).toBe('rev-1'));

    act(() => {
      result.current.advanceBaseRevision('rev-2');
    });
    expect(result.current.baseRevisionId).toBe('rev-2');
  });

  it('a page with no revision yet anchors to null', async () => {
    getYjsToken.mockResolvedValue(tokenOk(null));
    const { result } = renderHook(() => useCollabSession('page-1'), { wrapper: makeWrapper() });
    // Let the token resolve.
    await waitFor(() => expect(providerInstances.length).toBeGreaterThan(0));
    await new Promise((r) => setTimeout(r, 10));
    expect(result.current.baseRevisionId).toBeNull();
  });
});
