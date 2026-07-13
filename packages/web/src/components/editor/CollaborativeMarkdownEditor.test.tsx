import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, cleanup, act, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createElement, type PropsWithChildren } from 'react';
import * as Y from 'yjs';

// Module mocks: stub Hocuspocus + apiClient so we never touch a real
// WebSocket. `useYjsToken` reaches into `apiClient` so we mock that
// at the same boundary the production code uses. The shared stubs
// must live inside `vi.hoisted` so the auto-hoisted `vi.mock`
// factories can see them without tripping on the TDZ for ordinary
// top-level `const`s.
const { getYjsToken, FakeProvider, providerInstances } = vi.hoisted(() => {
  interface Instance {
    destroy: ReturnType<typeof vi.fn>;
    document: Y.Doc;
    awareness: object;
    config: Record<string, unknown> & {
      onStatus?: (e: { status: string }) => void;
      onAuthenticationFailed?: () => void;
      onSynced?: (e: { state: boolean }) => void;
    };
  }
  const instances: Instance[] = [];
  class FakeProvider {
    destroy: ReturnType<typeof vi.fn>;
    document: Y.Doc;
    awareness: object;
    config: Instance['config'];
    constructor(config: Instance['config']) {
      this.config = config;
      this.destroy = vi.fn();
      // The hook always supplies a `document`; we just keep the same
      // reference here so observer-driven tests see updates the hook
      // applies through that Y.Doc.
      this.document = config.document as Y.Doc;
      this.awareness = {
        setLocalState: vi.fn(),
        setLocalStateField: vi.fn(),
        getStates: () => new Map(),
        on: vi.fn(),
        off: vi.fn(),
      };
      instances.push({ destroy: this.destroy, document: this.document, awareness: this.awareness, config });
    }
    sendStateless = vi.fn();
  }
  return { getYjsToken: vi.fn(), FakeProvider, providerInstances: instances };
});

// RFC-0006 Batch 5 — `useYjsToken` reads `apiClientV2.pages[':id']
// ['yjs-token'].$get` (Response-shaped) instead of the ts-rest
// `apiClient.pageCollab.getYjsToken` envelope. The mock surface
// matches what `apiClientV2` (a `createClient` typed client) exposes
// at runtime.
vi.mock('@/lib/api-client', () => ({
  apiClientV2: {
    pages: {
      ':id': {
        'yjs-token': { $get: getYjsToken },
      },
    },
  },
  // RFC-0004: the paste handler's upload-placeholder builds its URL from
  // `apiV2BaseUrl()` (read at call time) — the editor imports it transitively.
  apiV2BaseUrl: () => 'http://localhost:4301/api/v2',
}));

// Phase 8: useCollabSession now reads `useAuth()` to publish the
// local user identity into awareness. Mock it out so the test
// doesn't reach into `localStorage` / fetch for `/auth/me`. The
// minimal shape mirrors `useAuth`'s return type — we only consume
// `user` + `isLoading` in the editor wrapper.
vi.mock('@/lib/use-auth', () => ({
  useAuth: () => ({
    user: {
      id: 'test-user-id',
      username: 'tester',
      email: 'tester@example.com',
      name: 'Tester',
      status: 2,
      createdAt: new Date().toISOString(),
    },
    isLoading: false,
    isAuthenticated: true,
    logout: vi.fn(),
    refetch: vi.fn(),
  }),
}));

vi.mock('@hocuspocus/provider', () => ({
  HocuspocusProvider: FakeProvider,
  WebSocketStatus: {
    Connecting: 'connecting',
    Connected: 'connected',
    Disconnected: 'disconnected',
  },
}));

// `y-codemirror.next` needs a no-op stub because its real implementation
// expects yjs awareness wiring that our fake provider doesn't replicate.
// Returning an empty extension is enough to keep CodeMirror happy.
vi.mock('y-codemirror.next', () => ({
  yCollab: () => [],
}));

import { CollaborativeMarkdownEditor } from './CollaborativeMarkdownEditor';

afterEach(() => {
  cleanup();
  providerInstances.length = 0;
  getYjsToken.mockReset();
});

function makeWrapper() {
  // `retryDelay: 0` mirrors the `use-yjs-token.test.ts` setup — the
  // hook's hard-coded `retry: 3` would otherwise add ~5s of
  // backoff to any error-path test.
  const client = new QueryClient({
    defaultOptions: { queries: { retryDelay: 0, gcTime: 0 } },
  });
  return function Wrapper({ children }: PropsWithChildren) {
    return createElement(QueryClientProvider, { client }, children);
  };
}

const validTokenResponse = (overrides: { readonly?: boolean; pageId?: string } = {}) => ({
  wsToken: 'jwt.test.token',
  pageId: overrides.pageId ?? 'page-1',
  expiresAt: new Date(Date.now() + 5 * 60 * 1000).toISOString(),
  readonly: overrides.readonly ?? false,
});

/** Build a `Response`-shaped mock matching what `apiClientV2`'s real fetch returns. */
const tokenOkResponse = <T,>(body: T): { ok: true; status: number; json: () => Promise<T> } => ({
  ok: true,
  status: 200,
  json: () => Promise.resolve(body),
});

beforeEach(() => {
  getYjsToken.mockResolvedValue(tokenOkResponse(validTokenResponse()));
});

describe('CollaborativeMarkdownEditor', () => {
  it('mounts the inner editor and creates a Hocuspocus provider once the token arrives', async () => {
    const { container } = render(createElement(CollaborativeMarkdownEditor, { pageId: 'page-1' }), {
      wrapper: makeWrapper(),
    });

    // The bare editor mounts immediately (empty doc), so `.cm-content`
    // exists before the wsToken resolves.
    expect(container.querySelector('.cm-content')).not.toBeNull();

    await waitFor(() => expect(providerInstances).toHaveLength(1));
    expect(providerInstances[0].config.name).toBe('page-1');
    expect(providerInstances[0].config.token).toBe('jwt.test.token');
  });

  it('forwards status callbacks to the caller', async () => {
    const onStatusChange = vi.fn();
    render(createElement(CollaborativeMarkdownEditor, { pageId: 'page-1', onStatusChange }), {
      wrapper: makeWrapper(),
    });

    await waitFor(() => expect(providerInstances).toHaveLength(1));

    act(() => {
      providerInstances[0].config.onStatus?.({ status: 'connected' });
    });

    await waitFor(() => expect(onStatusChange).toHaveBeenCalledWith('connected'));
  });

  it('forwards readonly transitions to the caller', async () => {
    const onReadonlyChange = vi.fn();
    getYjsToken.mockResolvedValueOnce(tokenOkResponse(validTokenResponse({ readonly: true })));

    render(createElement(CollaborativeMarkdownEditor, { pageId: 'page-1', onReadonlyChange }), {
      wrapper: makeWrapper(),
    });

    await waitFor(() => expect(onReadonlyChange).toHaveBeenCalledWith(true));
  });

  it('mirrors Y.Text content to the caller via onYTextChange', async () => {
    const onYTextChange = vi.fn();
    render(createElement(CollaborativeMarkdownEditor, { pageId: 'page-1', onYTextChange }), {
      wrapper: makeWrapper(),
    });

    await waitFor(() => expect(providerInstances).toHaveLength(1));
    const { document } = providerInstances[0];
    const yText = document.getText('content');

    act(() => {
      yText.insert(0, 'hello from remote');
    });

    await waitFor(() => {
      expect(onYTextChange).toHaveBeenCalledWith('hello from remote');
    });
  });

  it('does not open its own provider when a session prop is supplied', () => {
    const session = {
      yText: null,
      yUndoManager: null,
      awareness: null,
      status: 'connecting' as const,
      synced: false,
      hasEverSynced: false,
      authRecoveryExhausted: false,
      readonly: false,
      subscribeStateless: () => () => undefined,
      sendStateless: () => false,
    };
    render(createElement(CollaborativeMarkdownEditor, { session }), { wrapper: makeWrapper() });

    // Token query must not fire either, because the session-driven
    // wrapper shouldn't trigger `useYjsToken`.
    expect(getYjsToken).not.toHaveBeenCalled();
    expect(providerInstances).toHaveLength(0);
  });

  it('converges two Y.Docs via update exchange (CRDT smoke)', () => {
    // Anchor test: confirm that two independent Y.Docs holding a
    // `Y.Text` named 'content' converge to the same string after a
    // bidirectional update swap. This is Yjs's own invariant and the
    // basis on which the realtime layer depends — keeping it here
    // means a future refactor that breaks Y.Text wiring trips this
    // simple, fast smoke before the higher-level tests light up.
    const docA = new Y.Doc();
    const docB = new Y.Doc();
    docA.getText('content').insert(0, 'hello ');
    docB.getText('content').insert(0, 'world');

    const updateA = Y.encodeStateAsUpdate(docA);
    const updateB = Y.encodeStateAsUpdate(docB);
    Y.applyUpdate(docB, updateA);
    Y.applyUpdate(docA, updateB);

    expect(docA.getText('content').toString()).toBe(docB.getText('content').toString());
  });
});
