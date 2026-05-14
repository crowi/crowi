'use client';

import { useEffect, useState } from 'react';
import { HocuspocusProvider, WebSocketStatus } from '@hocuspocus/provider';
import type { Awareness } from 'y-protocols/awareness';
import * as Y from 'yjs';

/**
 * Re-export of `y-protocols/awareness#Awareness` so that downstream
 * components don't need to depend on `y-protocols` directly. Hocuspocus
 * owns the actual awareness instance via `provider.awareness`; we just
 * surface it through the hook's return type.
 */
export type CollabAwareness = Awareness;

/**
 * Discrete connection state surfaced to React, normalised away from
 * Hocuspocus's stringly-typed `WebSocketStatus`. `'auth-failed'` is a
 * terminal state set when the server rejects the wsToken (= we do not
 * try to reconnect with the same token; the caller switches to
 * readonly until the next token refresh).
 */
export type CollabStatus = 'connecting' | 'connected' | 'disconnected' | 'auth-failed';

interface UseCollabDocumentOptions {
  pageId: string | null | undefined;
  wsToken: string | null | undefined;
  /**
   * Sticky readonly bit from the wsToken response — `true` once the
   * 20-user editor cap is reached at issue time. Server-side Hocuspocus
   * also enforces this on `onAuthenticate`; we OR both into the
   * returned `readonly` value so the editor disables writes
   * defensively even if the server forgets to set the flag.
   */
  initialReadonly?: boolean;
}

interface UseCollabDocumentResult {
  ydoc: Y.Doc | null;
  yText: Y.Text | null;
  yUndoManager: Y.UndoManager | null;
  awareness: CollabAwareness | null;
  status: CollabStatus;
  readonly: boolean;
}

/**
 * RFC-0003 Phase 7 — owns the `HocuspocusProvider` lifecycle for one
 * page-scoped collab session.
 *
 * Token refresh strategy: when `wsToken` changes (use-yjs-token
 * refetched ~30s before expiry), we destroy the provider and recreate
 * it. Hocuspocus 4.x has no runtime token-swap API; keeping the same
 * `Y.Doc` would preserve local edits in theory, but reconnect with a
 * fresh provider means the server replays any missing updates on
 * `onLoadDocument`, so we trade ~1 round-trip for code simplicity.
 *
 * Page navigation: when `pageId` changes the previous Y.Doc is
 * intentionally discarded — switching pages should always start from
 * the server's authoritative state to avoid bleeding stale cursors /
 * undo history across documents.
 *
 * Resilient to React Strict Mode double-invoke: the effect cleanup
 * tears down the provider before remount, so we never end up with two
 * live WebSockets pointing at the same document.
 */
export function useCollabDocument(options: UseCollabDocumentOptions): UseCollabDocumentResult {
  const { pageId, wsToken, initialReadonly = false } = options;

  // Bundle the Yjs handles into one state slot so the mount effect
  // only fires `setSession` once when the provider is constructed (and
  // once with `null` on teardown). The bundled write satisfies the
  // `react-hooks/set-state-in-effect` rule: we update React state
  // exactly when an external resource (HocuspocusProvider) is created
  // or torn down — the classic "subscribe + publish" effect shape.
  interface SessionHandles {
    ydoc: Y.Doc;
    yText: Y.Text;
    yUndoManager: Y.UndoManager;
    awareness: CollabAwareness;
  }
  const [session, setSession] = useState<SessionHandles | null>(null);
  const [status, setStatus] = useState<CollabStatus>('connecting');

  useEffect(() => {
    if (!pageId || !wsToken) return;

    const url = process.env.NEXT_PUBLIC_COLLAB_URL ?? 'ws://localhost:3302';
    const doc = new Y.Doc();
    const undoManager = new Y.UndoManager(doc.getText('content'));

    const provider = new HocuspocusProvider({
      url,
      name: pageId,
      token: wsToken,
      document: doc,
      onStatus: ({ status: wsStatus }) => {
        if (wsStatus === WebSocketStatus.Connecting) {
          setStatus('connecting');
        } else if (wsStatus === WebSocketStatus.Connected) {
          setStatus('connected');
        } else if (wsStatus === WebSocketStatus.Disconnected) {
          setStatus('disconnected');
        }
      },
      onAuthenticationFailed: () => {
        // Token verify failed (expired / wrong secret / cross-page). We
        // don't reconnect — the next use-yjs-token refetch will hand
        // us a fresh token and the parent effect will rebuild the
        // provider with it.
        setStatus('auth-failed');
      },
    });

    // `provider.awareness` is typed `Awareness | null` because the user
    // can opt out via `awareness: null` — we never do, so the runtime
    // value is always set. Non-null assertion at the type boundary.
    const awareness = provider.awareness as CollabAwareness;

    // The session publish is the React-side notification that the
    // external Hocuspocus resource has been constructed. The lint rule
    // (`react-hooks/set-state-in-effect`) cannot tell this apart from
    // a derived-state mis-use; suppress with the explicit justification
    // that ownership of the Y.Doc + provider lifetime is exactly this
    // effect (see cleanup below).
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setSession({ ydoc: doc, yText: doc.getText('content'), yUndoManager: undoManager, awareness });

    return () => {
      // Destroy order matters: undo manager holds a reference to the
      // Y.Text observer, so kill it first, then the provider (which
      // unhooks awareness + WebSocket), then the doc.
      undoManager.destroy();
      provider.destroy();
      doc.destroy();
      setSession(null);
      setStatus('connecting');
    };
  }, [pageId, wsToken]);

  // Readonly OR layer: sticky bit from the wsToken response (Phase 6
  // server-side cap defence; the server precomputes it at token issue
  // time) OR the auth-failed terminal state.
  const readonly = initialReadonly || status === 'auth-failed';

  return {
    ydoc: session?.ydoc ?? null,
    yText: session?.yText ?? null,
    yUndoManager: session?.yUndoManager ?? null,
    awareness: session?.awareness ?? null,
    status,
    readonly,
  };
}
