'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { HocuspocusProvider, WebSocketStatus } from '@hocuspocus/provider';
import type { Awareness } from 'y-protocols/awareness';
import * as Y from 'yjs';

/**
 * Resolve the WebSocket endpoint the HocuspocusProvider should
 * connect to. RFC-0003 Phase 8.5 (same-process attach):
 *
 *   1. `NEXT_PUBLIC_COLLAB_URL` env wins when set — operators that
 *      front collab on a distinct host (e.g. `wss://collab.example.com`)
 *      configure it explicitly.
 *   2. Otherwise derive from `NEXT_PUBLIC_API_URL` — same host the
 *      HTTP client (`api-client.ts`) uses. The api process is the
 *      one that runs the embedded Hocuspocus engine, so collab WS
 *      and HTTP requests target the same origin. `http(s)://` →
 *      `ws(s)://` rewrite picks the right protocol automatically.
 *
 * **Why not `window.location.host`?** Next.js's `rewrites()` config
 * is HTTP-only — it does NOT proxy WebSocket `upgrade` events. So in
 * the dev split (web :3301 / api :3300) a location-derived URL would
 * hit the Next.js dev server, which has no handler for the upgrade
 * and silently drops the connection. Routing through the same env
 * the HTTP client uses keeps dev and prod consistent.
 *
 * Fallback `'http://localhost:3300'` mirrors `api-client.ts` /
 * `next.config.ts`, so an unset `NEXT_PUBLIC_API_URL` resolves to
 * the dev api port out of the box.
 */
function resolveCollabUrl(): string {
  const fromEnv = process.env.NEXT_PUBLIC_COLLAB_URL;
  if (fromEnv && fromEnv.length > 0) return fromEnv;
  const apiUrl = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3300';
  // `^http` matches both `http` and `https`; the prepend yields
  // `ws://` / `wss://` accordingly. The `/collab` suffix lines the
  // base URL up so HocuspocusProvider's `${url}/${name}` join
  // produces `ws[s]://<host>/collab/<pageId>` — matching the path
  // filter in `packages/api/src/collab/attach.ts`.
  return `${apiUrl.replace(/^http/, 'ws')}/collab`;
}

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

/**
 * Awareness `user` field shape published to remote peers. y-codemirror.next
 * renders the caret using `color` and the selection background using
 * `colorLight`; the optional `id` lets the same-paragraph indicator map
 * states back to the application's user model. Mirrors the format the
 * upstream `y-codemirror.next` demo uses (see
 * `y-codemirror.next/dist/src/y-remote-selections.js`).
 */
export interface CollabUserField {
  id?: string;
  /** Stable account identifier; seeds `UserAvatar`'s boring-avatar variant. */
  username?: string;
  name: string;
  /** Optional profile image URL — surfaced by `UserAvatar` when present. */
  image?: string | null;
  color: string;
  colorLight?: string;
}

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

/**
 * Subscriber callback for the stateless multi-consumer fan-out. The
 * payload is the raw string Hocuspocus delivers — listeners run zod
 * `safeParse` against the per-message schemas (`CollabSaveOkSchema`,
 * `CollabSaveErrorSchema`, `CollabForceReloadMessageSchema`) to claim
 * the payload, and silently drop messages they don't recognise so
 * unrelated consumers can co-exist on the same channel.
 */
export type StatelessListener = (payload: string) => void;

interface UseCollabDocumentResult {
  ydoc: Y.Doc | null;
  yText: Y.Text | null;
  yUndoManager: Y.UndoManager | null;
  awareness: CollabAwareness | null;
  provider: HocuspocusProvider | null;
  status: CollabStatus;
  readonly: boolean;
  /**
   * Publish the local user identity to remote peers via
   * `awareness.setLocalStateField('user', ...)`. No-op until the
   * provider has been constructed; callers should fire this in a
   * `useEffect` keyed by `[awareness, user]` and pass `null` to clear.
   */
  setLocalAwareness: (user: CollabUserField | null) => void;
  /**
   * Subscribe to inbound stateless messages. The hook owns one
   * `onStateless` callback on the provider config; this fan-out lets
   * the Save flow and the force-reload dialog listen independently
   * without stomping on each other.
   *
   * Returns an unsubscribe function — mirror the standard pub-sub
   * shape so callers can drop the listener into `useEffect`'s cleanup
   * slot.
   */
  subscribeStateless: (listener: StatelessListener) => () => void;
  /**
   * Send a custom message to the server over Hocuspocus's stateless
   * channel. Used by `useCollabSave` to fire `crowi:save`. No-op
   * (returns `false`) when the provider isn't ready or the session is
   * readonly; callers should treat that as `'NOT_READY'` / `'READONLY'`.
   */
  sendStateless: (payload: string) => boolean;
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
 *
 * Phase 8 additions:
 *   - `provider` is surfaced on the return so callers can fire
 *     `sendStateless()` for custom messages like `crowi:save`
 *   - `setLocalAwareness` is the typed entry point for publishing the
 *     authenticated user's name + color to remote peers
 *   - `subscribeStateless` fans the provider's single `onStateless`
 *     hook out to multiple listeners (Save flow + force-reload dialog)
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
    provider: HocuspocusProvider;
  }
  const [session, setSession] = useState<SessionHandles | null>(null);
  const [status, setStatus] = useState<CollabStatus>('connecting');

  // Stateless listener fan-out. `Set` instead of `Array` so unsubscribe
  // is O(1) and identical listeners can't double-register. The ref
  // outlives provider rebuilds (token refresh swaps providers but keeps
  // listeners), so callers don't need to re-subscribe on every cycle.
  const statelessListenersRef = useRef<Set<StatelessListener>>(new Set());

  useEffect(() => {
    if (!pageId || !wsToken) return;

    const url = resolveCollabUrl();
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
      onStateless: ({ payload }) => {
        // Fan-out to subscribers. We iterate over a snapshot (`[...set]`)
        // so a listener that unsubscribes itself during dispatch doesn't
        // mutate the live set under iteration.
        for (const listener of [...statelessListenersRef.current]) {
          try {
            listener(payload);
          } catch (err) {
            // Don't let one bad listener kill the others. Use console
            // here — no logger plumbing in this layer — and keep going.
            console.error('[collab] stateless listener threw', err);
          }
        }
      },
    });

    // `provider.awareness` is typed `Awareness | null` because the user
    // can opt out via `awareness: null` — we never do, so the runtime
    // value is always set. Non-null assertion at the type boundary.
    const awareness = provider.awareness as CollabAwareness;

    // The session publish is the React-side notification that the
    // external Hocuspocus resource has been constructed. Ownership of
    // the Y.Doc + provider lifetime is exactly this effect — see
    // cleanup below.
    setSession({ ydoc: doc, yText: doc.getText('content'), yUndoManager: undoManager, awareness, provider });

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

  const setLocalAwareness = useCallback(
    (user: CollabUserField | null) => {
      const awareness = session?.awareness;
      if (!awareness) return;
      // `null` clears the field so a logged-out / unmounting consumer
      // can stop appearing in remote peers' awareness view.
      awareness.setLocalStateField('user', user);
    },
    [session],
  );

  const subscribeStateless = useCallback((listener: StatelessListener) => {
    statelessListenersRef.current.add(listener);
    return () => {
      statelessListenersRef.current.delete(listener);
    };
  }, []);

  const sendStateless = useCallback(
    (payload: string) => {
      const provider = session?.provider;
      if (!provider || readonly) return false;
      provider.sendStateless(payload);
      return true;
    },
    [session, readonly],
  );

  return {
    ydoc: session?.ydoc ?? null,
    yText: session?.yText ?? null,
    yUndoManager: session?.yUndoManager ?? null,
    awareness: session?.awareness ?? null,
    provider: session?.provider ?? null,
    status,
    readonly,
    setLocalAwareness,
    subscribeStateless,
    sendStateless,
  };
}
