import { describe, it, expect, beforeEach, vi } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import * as Y from 'yjs';

// Fake HocuspocusProvider — captures `onStatus` / `onAuthenticationFailed`
// callbacks so tests can trigger transitions explicitly. We use
// `vi.hoisted` to lift the constructor + the per-test instance list
// above the auto-hoisted `vi.mock` call so both the factory and the
// test bodies can reach them without a TDZ violation.
const { FakeProvider, providerInstances } = vi.hoisted(() => {
  interface Instance {
    destroy: ReturnType<typeof vi.fn>;
    document: Y.Doc;
    awareness: object;
    config: {
      onStatus?: (e: { status: string }) => void;
      onAuthenticationFailed?: () => void;
    } & Record<string, unknown>;
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
      // Hocuspocus normally creates its own Y.Doc when `document` is
      // not passed, but our hook always passes one. Mirror that here
      // so observers on `yText` keep working in tests.
      // The hook always supplies a document; we just rely on that
      // here to avoid importing yjs inside the hoisted factory block.
      this.document = config.document as Y.Doc;
      this.awareness = { setLocalState: vi.fn(), getStates: () => new Map(), on: vi.fn(), off: vi.fn() };
      instances.push({ destroy: this.destroy, document: this.document, awareness: this.awareness, config });
    }
  }
  return { FakeProvider, providerInstances: instances };
});
vi.mock('@hocuspocus/provider', () => ({
  HocuspocusProvider: FakeProvider,
  WebSocketStatus: {
    Connecting: 'connecting',
    Connected: 'connected',
    Disconnected: 'disconnected',
  },
}));

import { useCollabDocument } from './use-collab-document';

beforeEach(() => {
  providerInstances.length = 0;
});

describe('useCollabDocument', () => {
  it('does not create a provider when pageId is missing', () => {
    renderHook(() => useCollabDocument({ pageId: null, wsToken: null }));
    expect(providerInstances).toHaveLength(0);
  });

  it('does not create a provider when wsToken is missing', () => {
    renderHook(() => useCollabDocument({ pageId: 'page-1', wsToken: null }));
    expect(providerInstances).toHaveLength(0);
  });

  it('builds the provider once pageId + wsToken are both supplied', () => {
    const { result } = renderHook(() => useCollabDocument({ pageId: 'page-1', wsToken: 'jwt.abc' }));
    expect(providerInstances).toHaveLength(1);
    expect(providerInstances[0].config.name).toBe('page-1');
    expect(providerInstances[0].config.token).toBe('jwt.abc');
    expect(result.current.yText).not.toBeNull();
    expect(result.current.yUndoManager).not.toBeNull();
    expect(result.current.awareness).not.toBeNull();
  });

  it('reports the status emitted by the provider', () => {
    const { result } = renderHook(() => useCollabDocument({ pageId: 'page-1', wsToken: 'jwt.abc' }));
    expect(result.current.status).toBe('connecting');

    act(() => {
      providerInstances[0].config.onStatus?.({ status: 'connected' });
    });
    expect(result.current.status).toBe('connected');

    act(() => {
      providerInstances[0].config.onStatus?.({ status: 'disconnected' });
    });
    expect(result.current.status).toBe('disconnected');
  });

  it('flips readonly on authentication failure', () => {
    const { result } = renderHook(() => useCollabDocument({ pageId: 'page-1', wsToken: 'jwt.abc' }));
    expect(result.current.readonly).toBe(false);

    act(() => {
      providerInstances[0].config.onAuthenticationFailed?.();
    });
    expect(result.current.readonly).toBe(true);
    expect(result.current.status).toBe('auth-failed');
  });

  it('propagates the initialReadonly bit from the wsToken response', () => {
    const { result } = renderHook(() => useCollabDocument({ pageId: 'page-1', wsToken: 'jwt.abc', initialReadonly: true }));
    expect(result.current.readonly).toBe(true);
  });

  it('destroys the provider on unmount', () => {
    const { unmount } = renderHook(() => useCollabDocument({ pageId: 'page-1', wsToken: 'jwt.abc' }));
    expect(providerInstances).toHaveLength(1);
    const destroy = providerInstances[0].destroy;
    unmount();
    expect(destroy).toHaveBeenCalled();
  });

  it('tears down and rebuilds the provider when wsToken changes', () => {
    const { rerender } = renderHook(({ token }) => useCollabDocument({ pageId: 'page-1', wsToken: token }), {
      initialProps: { token: 'jwt.first' },
    });
    expect(providerInstances).toHaveLength(1);
    const firstDestroy = providerInstances[0].destroy;

    rerender({ token: 'jwt.second' });
    expect(firstDestroy).toHaveBeenCalled();
    expect(providerInstances).toHaveLength(2);
    expect(providerInstances[1].config.token).toBe('jwt.second');
  });

  it('tears down and rebuilds the provider when pageId changes', () => {
    const { rerender } = renderHook(({ pageId }) => useCollabDocument({ pageId, wsToken: 'jwt' }), {
      initialProps: { pageId: 'page-1' },
    });
    expect(providerInstances).toHaveLength(1);
    const firstDestroy = providerInstances[0].destroy;

    rerender({ pageId: 'page-2' });
    expect(firstDestroy).toHaveBeenCalled();
    expect(providerInstances).toHaveLength(2);
    expect(providerInstances[1].config.name).toBe('page-2');
  });
});
