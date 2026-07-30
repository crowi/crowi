'use client';

import type { Extension } from '@codemirror/state';
import { keymap } from '@codemirror/view';
import { CollabForceReloadMessageSchema } from '@crowi/api-contract';
import { forwardRef, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { yCollab } from 'y-codemirror.next';
import type * as Y from 'yjs';
import { userColor } from '@/lib/collab-user-color';
import { useLinkCardEnabled } from '@/lib/use-app-info';
import { useAuth } from '@/lib/use-auth';
import type { CollabAwareness, StatelessListener } from '@/lib/use-collab-document';
import { type CollabStatus, useCollabDocument } from '@/lib/use-collab-document';
import { useYjsToken } from '@/lib/use-yjs-token';
import { MarkdownEditor, type MarkdownEditorHandle } from './markdown-editor';

/**
 * Pre-built realtime session, surfaced by `useCollabSession` so that a
 * single Hocuspocus connection can drive multiple `CollaborativeMarkdownEditor`
 * mounts (e.g. the wide + narrow editor panes in `/_edit` which both
 * stay in the DOM simultaneously via `display: none` toggling).
 *
 * `null` fields are valid and mean "session not ready yet" — the
 * wrapper will mount the inner editor in readonly mode until they
 * populate. This avoids spinning a placeholder UI while the wsToken
 * round-trip is in flight (usually < 100 ms on a warm session).
 *
 * Phase 8 additions:
 *   - `subscribeStateless` is the multi-consumer fan-out for inbound
 *     stateless messages (save acks + force-reload)
 *   - `sendStateless` is a thin guarded wrapper that no-ops on
 *     readonly / un-connected sessions
 */
export interface CollabSession {
  yText: Y.Text | null;
  yUndoManager: Y.UndoManager | null;
  awareness: CollabAwareness | null;
  status: CollabStatus;
  /**
   * editor-preview-reliability §2 — `true` once the initial Yjs sync has
   * completed (`provider.synced`). The Save guard gates on this, not
   * `status`, so the user can't save a pre-sync / offline doc. Dips to
   * `false` on a transient disconnect (block saves while offline).
   */
  synced: boolean;
  /**
   * editor-preview-reliability H5 / D1b — sticky "has synced at least once".
   * The editor's MOUNT gate uses this instead of `synced` so a transient
   * disconnect (which dips `synced`) doesn't remount CodeMirror / flip it
   * readonly mid-edit. Stays `true` through a routine `auth-failed` reconnect
   * (D1b — recovery keeps the editor mounted, showing "reconnecting…");
   * `useCollabSession` masks it to `false` only when recovery is GENUINELY
   * TERMINAL (`authRecoveryExhausted`) or the provider is rebuilt / the page
   * swaps.
   */
  hasEverSynced: boolean;
  /**
   * editor-preview-reliability D2 — `true` once the bounded auth-failed
   * recovery budget is spent (the wsToken keeps getting rejected after the
   * retries). The caller escalates this to a terminal "session expired —
   * sign in again" message and dismisses the "reconnecting…" spinner.
   *
   * D2 (round 3): the budget + this flag reset ONLY on a CONFIRMED sync
   * (`synced === true`), NOT on a transient `connecting`/`connected`. A
   * fetchable-but-rejected wsToken rebuilds the provider each cycle (status
   * oscillates auth-failed → connecting → auth-failed); counting attempts in
   * a ref that survives the oscillation is what lets the budget genuinely
   * drain to terminal instead of resetting every cycle (the infinite-spinner
   * bug). A real recovery (the doc re-syncs) clears it and re-arms.
   */
  authRecoveryExhausted: boolean;
  readonly: boolean;
  subscribeStateless: (listener: StatelessListener) => () => void;
  sendStateless: (payload: string) => boolean;
}

interface CollaborativeMarkdownEditorCommonProps {
  /** Forwarded to the inner `MarkdownEditor`'s wrapper `<div>`. */
  className?: string;
  /** Optional aria-label for the editor surface. */
  'aria-label'?: string;
  /**
   * Fires when the Y.Text content changes (local or remote). Caller
   * uses this to keep an in-React `body` string mirror for the
   * preview pane / attachment markdown insertion.
   *
   * `yText.toString()` is O(n) per call; the wrapper throttles
   * invocations to ≤ 7/sec (leading + trailing edge) and the
   * preview pane debounces by another 250 ms downstream, so even
   * large docs stay within typing-latency budget.
   */
  onYTextChange?: (next: string) => void;
  /** Connection status forwarded so the caller can fire user-visible toasts. */
  onStatusChange?: (status: CollabStatus) => void;
  /**
   * Toggles when the readonly mode flips (cap reached at token issue
   * time, or terminal auth failure). Caller disables the Save button
   * + surfaces a banner.
   */
  onReadonlyChange?: (readonly: boolean) => void;
  /**
   * RFC-0003 Phase 8 — fires when the server announces a force-reload
   * (`crowi:force-reload` stateless message). The caller is expected
   * to mount a `CollabForceReloadDialog` and pass `reason` through.
   * Skipping this prop means the page silently ignores the broadcast,
   * which is the correct degradation for the bare editor preview /
   * test harness use case where no dialog is wired up.
   */
  onForceReload?: (reason?: string) => void;
  /**
   * RFC-0004 Phase 6/7 — enables the editor's paste handler (URL
   * smart-link + image-blob upload) and drag-and-drop upload handler.
   * Required because both upload to `/api/attachments/upload`, which
   * is keyed by the owning page id. When the wrapper is driven by the
   * `pageId` prop this is the same id; the `session`-driven variant must
   * pass it explicitly. Omit to disable paste / D&D interception (bare
   * preview / test mounts).
   */
  uploadPageId?: string;
}

/**
 * XOR over `pageId` vs `session`: callers either hand the wrapper a
 * page id (it owns the Hocuspocus connection internally) OR a
 * pre-built session lifted from a parent (multi-pane mode). Supplying
 * both or neither is a type error.
 */
export type CollaborativeMarkdownEditorProps = CollaborativeMarkdownEditorCommonProps &
  ({ pageId: string; session?: never } | { pageId?: never; session: CollabSession });

/**
 * Hook variant of the realtime session — owns the wsToken fetch +
 * the HocuspocusProvider lifecycle in one place so a single page
 * editor with multiple mounted views (wide / narrow side-by-side
 * via `display: none` toggling) shares one connection.
 *
 * Phase 8: also publishes the authenticated user's awareness identity
 * (name + color) so y-codemirror.next can paint remote carets. The
 * identity republishes whenever `user` swaps — covers the
 * sign-in-after-page-load edge case and the (rare) profile-name
 * change during a live session.
 */
export function useCollabSession(pageId: string | null | undefined): CollabSession {
  // D1a — expose the LIVE connection status to `useYjsToken` so its
  // notifier-driven refetch can skip while we're `connected` (an established
  // WebSocket doesn't care that the wsToken's TTL lapsed; refetching would
  // only rebuild the provider + remount the editor). `useYjsToken` runs
  // before `useCollabDocument` in this hook, so we feed the status through a
  // ref updated by an effect once `status` is known.
  const connectionStatusRef = useRef<CollabStatus>('connecting');
  const getConnectionStatus = useCallback(() => connectionStatusRef.current, []);
  const tokenQuery = useYjsToken(pageId, { getConnectionStatus });
  const wsToken = tokenQuery.data?.wsToken ?? null;
  const tokenReadonly = tokenQuery.data?.readonly ?? false;
  const { yText, yUndoManager, awareness, status, synced, hasEverSynced, readonly, setLocalAwareness, subscribeStateless, sendStateless } = useCollabDocument({
    pageId,
    wsToken,
    initialReadonly: tokenReadonly,
  });
  useEffect(() => {
    connectionStatusRef.current = status;
  }, [status]);

  // Decision 1 (round 2): the save optimistic lock moved SERVER-SIDE
  // (anchored to the revision the server's Hocuspocus doc was materialised
  // from), so the client no longer pins / advances any edit-base revision.
  // The whole client-base subsystem (baseRevisionId state, the once-per-page
  // anchoring, advanceBaseRevision) was removed.

  // §4 / D2 — bounded recovery from the `auth-failed` state with a
  // SELF-RESCHEDULING backoff + terminal escalation. The provider won't
  // reconnect with the rejected token; a fresh wsToken rebuilds it.
  // `useYjsToken` already refetches on a silent access-token refresh (the
  // common case), but `auth-failed` can also happen with a still-valid
  // access token (the wsToken simply expired), so nudge a bounded number of
  // explicit refetches here.
  //
  // D2 — surface "budget spent" so the caller can escalate to a terminal
  // message + dismiss the reconnecting spinner instead of spinning forever.
  const [authRecoveryExhausted, setAuthRecoveryExhausted] = useState(false);
  // D2 (round 3) — the attempt counter MUST survive the provider oscillation.
  // For a wsToken the server keeps rejecting (e.g. WS_TOKEN_SECRET mismatch /
  // revoked), each refetch produces a fetchable-but-rejected token that
  // rebuilds the provider, so status churns auth-failed → connecting →
  // auth-failed. If the budget lived in the effect's local scope it would
  // reset to 0 on every re-arm and the terminal state would never be reached
  // (the infinite "reconnecting…" spinner). Holding it in a ref means the
  // count only resets on a CONFIRMED successful sync (see the effect below),
  // not on a transient connecting/connected, so the budget genuinely drains.
  const authAttemptRef = useRef(0);
  // D2 — reset the recovery budget ONLY on a confirmed sync. A transient
  // `connecting`/`connected` during the oscillation does NOT count as
  // recovery (the rebuilt provider can immediately auth-fail again); only
  // `synced === true` proves the fresh token actually authenticated AND the
  // doc re-synced. This is what makes the escalation reachable.
  useEffect(() => {
    if (!synced) return;
    authAttemptRef.current = 0;
    // Resetting the terminal flag on the external `synced` signal is the
    // "subscribe + publish" shape this effect exists for (the Yjs provider is
    // the external resource). The functional update is a no-op render when the
    // flag is already cleared (the common case), so it doesn't cascade.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setAuthRecoveryExhausted((prev) => (prev ? false : prev));
  }, [synced]);
  // H8 — depend on the STABLE `tokenQuery.refetch` (react-query keeps its
  // identity stable across renders), not the whole `tokenQuery` object
  // (new identity every render).
  const refetchToken = tokenQuery.refetch;
  useEffect(() => {
    // Only the auth-failed branch arms the backoff. We deliberately do NOT
    // call setState synchronously in the effect body (that would trip
    // cascading renders); the only setState is the async "budget spent"
    // inside a setTimeout, and the budget reset lives in the confirmed-sync
    // effect above (NOT in this cleanup — resetting on every leave-auth-failed
    // is exactly the oscillation bug that kept the spinner alive forever).
    if (status !== 'auth-failed') return;
    // Already escalated to terminal for this drained budget — don't re-arm
    // the chain (it would refetch forever). A confirmed sync re-arms us by
    // resetting `authAttemptRef` + clearing the terminal flag.
    if (authRecoveryExhausted) return;

    // D2 — a single effect owns the whole backoff for THIS auth-failed
    // episode: it arms timer #1, whose callback refetches then arms timer
    // #2, etc. (1s, 2s, 4s). The attempt count persists in `authAttemptRef`
    // across provider rebuilds, so a fetchable-but-rejected wsToken drains
    // the budget across the oscillation instead of resetting each cycle.
    // After the 3rd attempt we escalate to terminal instead of looping.
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const scheduleNext = (): void => {
      if (cancelled) return;
      if (authAttemptRef.current >= 3) {
        setAuthRecoveryExhausted(true);
        return;
      }
      const delay = 1000 * 2 ** authAttemptRef.current; // 1s, 2s, 4s
      authAttemptRef.current += 1;
      timer = setTimeout(() => {
        void Promise.resolve(refetchToken()).finally(() => {
          // If the refetch produced a token that re-syncs, `synced` flips and
          // the confirmed-sync effect resets the budget; if status leaves
          // auth-failed transiently this effect's cleanup cancels the in-flight
          // timer (but keeps the count). If it stays / returns to auth-failed
          // (still-bad credentials), self-reschedule until the budget drains.
          scheduleNext();
        });
      }, delay);
    };
    scheduleNext();
    return () => {
      // Cancel only the in-flight timer; keep `authAttemptRef` so the count
      // survives a provider rebuild's transient connecting state.
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [status, refetchToken, authRecoveryExhausted]);

  // D1b (round 3) — the editor's MOUNT gate (`hasEverSynced`) must hold the
  // editor mounted through a routine reconnect, and only tear down when
  // recovery is GENUINELY TERMINAL. `useCollabDocument` no longer clears
  // `hasEverSynced` on `auth-failed`; instead we mask it here once the
  // bounded recovery budget is spent, so the editor stays "reconnecting…"
  // during recovery and flips to the terminal "session expired" state only
  // when we've truly given up.
  const effectiveHasEverSynced = hasEverSynced && !authRecoveryExhausted;

  const { user, isLoading: isAuthLoading } = useAuth();

  // Publish the local user identity into awareness so peers can paint
  // a named caret + selection. Deps are pinned to the primitive user
  // fields we actually publish — react-query refetches return a fresh
  // `user` object reference even when nothing changed, and broadcasting
  // an identical identity to every peer would amplify the per-keystroke
  // awareness traffic across the cluster.
  const userId = user?.id;
  const userName = user?.name;
  const userUsername = user?.username;
  const userImage = user?.image;
  useEffect(() => {
    if (!awareness || isAuthLoading) return;
    if (!userId) {
      setLocalAwareness(null);
      return;
    }
    const palette = userColor(userId);
    setLocalAwareness({
      id: userId,
      username: userUsername,
      name: userName?.trim() || (userUsername ?? userId),
      image: userImage ?? null,
      color: palette.color,
      colorLight: palette.colorLight,
    });
  }, [awareness, userId, userName, userUsername, userImage, isAuthLoading, setLocalAwareness]);

  // Local-typing indicator: stamp `awareness.typingAt = Date.now()` on
  // every local Y.Text mutation so remote peers can render a "typing"
  // overlay over our avatar. Throttled to one publish per 750 ms to
  // keep the awareness channel quiet during sustained typing; the
  // viewer-side 3 s freshness window in `CollabPresenceAvatars`
  // bridges the gap between publishes. Cleanup clears the field on
  // unmount so a stale "still typing" doesn't outlive the session.
  useEffect(() => {
    if (!yText || !awareness) return;
    const THROTTLE_MS = 750;
    let lastPublish = 0;
    const observer = (_event: Y.YTextEvent, transaction: Y.Transaction): void => {
      // `transaction.local === false` means this mutation came from a
      // remote peer's update — we don't want to mark ourselves as
      // typing on every inbound delta or the entire cluster would
      // light up in unison.
      if (!transaction.local) return;
      const now = Date.now();
      if (now - lastPublish < THROTTLE_MS) return;
      lastPublish = now;
      awareness.setLocalStateField('typingAt', now);
    };
    yText.observe(observer);
    return () => {
      yText.unobserve(observer);
      awareness.setLocalStateField('typingAt', null);
    };
  }, [yText, awareness]);

  return {
    yText,
    yUndoManager,
    awareness,
    status,
    synced,
    hasEverSynced: effectiveHasEverSynced,
    authRecoveryExhausted,
    readonly,
    subscribeStateless,
    sendStateless,
  };
}

/**
 * RFC-0003 Phase 7 — realtime-collab wrapper around `MarkdownEditor`.
 *
 * Architecture: this component owns
 *   - (optional) the wsToken fetch (`useYjsToken`) via `useCollabSession`
 *   - (optional) the HocuspocusProvider lifecycle (`useCollabDocument`)
 *   - the `yCollab` CodeMirror extension assembly
 *   - the `Y.UndoManager` keymap binding (Mod-z / Mod-Shift-z)
 *
 * When a parent already manages the session (multi-pane case), pass
 * the `session` prop in instead of `pageId`. The wrapper exposes the
 * same `MarkdownEditorHandle` API as the bare editor via `forwardRef`,
 * so existing call-sites (`useScrollSync`, `AttachmentInsertButton`)
 * keep working without modification.
 *
 * The `value` / `onChange` props of the inner `MarkdownEditor` are
 * intentionally pinned at `''` / a no-op: once `yCollab` owns the
 * doc, the EditorView's content is driven entirely by Y.Text. Setting
 * `value=''` once at mount avoids the parent's echo-guard sync effect
 * from racing against incoming Yjs updates.
 *
 * Phase 8 additions:
 *   - listens for `crowi:force-reload` on the stateless channel and
 *     forwards the reason to the optional `onForceReload` callback
 *     (the caller mounts the actual dialog)
 */
export const CollaborativeMarkdownEditor = forwardRef<MarkdownEditorHandle, CollaborativeMarkdownEditorProps>(function CollaborativeMarkdownEditor(props, ref) {
  const { pageId, session, className, 'aria-label': ariaLabel, onYTextChange, onStatusChange, onReadonlyChange, onForceReload, uploadPageId } = props;

  // feature-renderer-plugin-boundary Phase 3 — gate the inner editor's
  // link-card conversion affordance on the `link-card` app-info
  // capability. `useAppInfo()` shares the SAME query the auth shell's
  // `RendererStylesheets` already primes on mount, so this is normally
  // a cache hit, not a new fetch. Defaults to enabled (`true`) while the
  // query is loading — same optimistic default-on the toggle itself
  // uses.
  const linkCardEnabled = useLinkCardEnabled();

  // Upload page id for the paste (Phase 6) + drag-and-drop (Phase 7)
  // handlers: an explicit `uploadPageId` wins; otherwise fall back to
  // the `pageId` prop when the wrapper owns the connection. Both
  // handlers upload to the same `/api/attachments/upload` keyed by
  // the page, so they share this config object.
  const uploadConfig = useMemo<{ pageId: string } | undefined>(() => {
    const id = uploadPageId ?? pageId;
    return id ? { pageId: id } : undefined;
  }, [uploadPageId, pageId]);

  // When the caller supplies a session, skip the internal hook
  // (otherwise we'd open a second WebSocket). React's rules require
  // unconditional hook calls, so we always invoke `useCollabSession`
  // and pass `null` for the disabled branch — the hook short-circuits
  // its own `useQuery` via the `enabled` flag.
  const ownedSession = useCollabSession(session ? null : pageId);
  const active = session ?? ownedSession;
  const { yText, yUndoManager, awareness, status, hasEverSynced, readonly, subscribeStateless } = active;

  // §2 — readiness is the initial-sync gate, not merely `yText != null`.
  // `yText` is non-null the instant the provider is constructed (sync
  // pending), so the old `!yText` gate let the user type into an empty
  // pre-sync doc; those edits were silently dropped when SyncStep2
  // replaced the doc (lost update) and the preview showed blank.
  //
  // H5 — gate on `hasEverSynced` (sticky), NOT the live `synced`. `synced`
  // dips to `false` on a transient disconnect; if the MOUNT gate keyed off
  // it, a network blip would remount CodeMirror and flip it readonly
  // mid-edit (losing cursor/scroll/IME/undo). `hasEverSynced` stays true
  // across a reconnect (it only resets on provider rebuild / auth-failure),
  // so yCollab mounts once after the first sync and survives blips. The
  // save guard still uses the live `synced` (see `useCollabSave`), so
  // offline saving is still blocked while the editor stays mounted.
  const ready = Boolean(hasEverSynced && yText);

  // Build the CodeMirror extension list. `yCollab` is the bridge
  // that wires Y.Text ↔ EditorView (doc + selection); the explicit
  // keymap binds Mod-z / Mod-Shift-z to the Y.UndoManager so undo
  // stays Yjs-aware even though `disableHistory` strips the built-
  // in `historyKeymap`. We pass `[]` until the document is ready so
  // the editor can mount immediately with an empty doc and the user
  // sees the editor chrome rather than a spinner.
  const extraExtensions = useMemo<Extension[]>(() => {
    if (!ready || !yText || !awareness || !yUndoManager) return [];
    return [
      yCollab(yText, awareness, { undoManager: yUndoManager }),
      keymap.of([
        {
          key: 'Mod-z',
          run: () => {
            yUndoManager.undo();
            return true;
          },
          preventDefault: true,
        },
        {
          key: 'Mod-Shift-z',
          run: () => {
            yUndoManager.redo();
            return true;
          },
          preventDefault: true,
        },
      ]),
    ];
  }, [ready, yText, awareness, yUndoManager]);

  // Mirror Y.Text → caller's `body` string. Throttled to ≤ 7 emits
  // per second (leading-edge fire + trailing-edge guarantee) so the
  // parent's `setBody` doesn't trigger a full editor-shell re-render
  // on every keystroke. The preview pane's own 250 ms debounce
  // absorbs the slack downstream, and at sustained typing the React
  // tree updates stay smooth (the pre-throttle path was the dominant
  // source of input lag on long docs).
  useEffect(() => {
    if (!yText) return;
    const THROTTLE_MS = 150;
    let lastEmit = 0;
    let pendingId: ReturnType<typeof setTimeout> | null = null;
    const fire = () => {
      pendingId = null;
      const now = Date.now();
      // try/finally so a thrown `onYTextChange` (caller bug) still
      // advances `lastEmit`; otherwise the throttle would silently
      // drop the next 150 ms worth of observer events, masking the
      // exception's downstream impact.
      try {
        onYTextChange?.(yText.toString());
      } finally {
        lastEmit = now;
      }
    };
    const emit = () => {
      const elapsed = Date.now() - lastEmit;
      if (elapsed >= THROTTLE_MS) {
        fire();
        return;
      }
      // Already a trailing emit pending — keep it; it'll see the
      // latest yText state when it actually fires.
      if (pendingId !== null) return;
      pendingId = setTimeout(fire, THROTTLE_MS - elapsed);
    };
    fire(); // initial publish (covers `onLoadDocument`-seeded content)
    yText.observe(emit);
    return () => {
      yText.unobserve(emit);
      if (pendingId !== null) {
        clearTimeout(pendingId);
        pendingId = null;
      }
    };
  }, [yText, onYTextChange]);

  useEffect(() => {
    onStatusChange?.(status);
  }, [status, onStatusChange]);

  useEffect(() => {
    onReadonlyChange?.(readonly);
  }, [readonly, onReadonlyChange]);

  // Phase 8 — listen for `crowi:force-reload` on the stateless
  // channel. Subscribe is a no-op when no callback was supplied so
  // the bare-test mounts (and the create flow's read-only preview)
  // don't waste a listener slot.
  useEffect(() => {
    if (!onForceReload) return;
    const unsubscribe = subscribeStateless((payload: string) => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(payload);
      } catch {
        return;
      }
      const match = CollabForceReloadMessageSchema.safeParse(parsed);
      if (match.success) {
        onForceReload(match.data.reason);
      }
    });
    return unsubscribe;
  }, [subscribeStateless, onForceReload]);

  // §2 — until the initial sync completes we force readonly so the user
  // can't type into the empty pre-sync doc (those edits would be dropped
  // when SyncStep2 replaces the doc with the server's authoritative
  // content). `ready` = `synced && yText`; this replaces the old `!yText`
  // gate, which lifted readonly the instant the provider existed (= sync
  // pending, doc still empty).
  const editorReadonly = readonly || !ready;

  // No `onChange`: yCollab owns dispatch, so the inner editor skips
  // the updateListener entirely (see `build-extensions.ts`).
  //
  // `key` forces a fresh remount when the session becomes ready (and
  // again if the page — hence the Y.Text — swaps in place). This is
  // what fixes the intermittent "editor renders blank" bug: the inner
  // editor must mount with `yCollab` *already* in its initial
  // `EditorState` AND its doc seeded from `yText`, so `ySyncPlugin`
  // starts observing a doc that matches Y.Text. Hot-swapping `yCollab`
  // in via the compartment (the pre-fix path) raced the Hocuspocus
  // sync: if the doc was seeded before `yCollab` attached, the
  // already-present content produced no observe event and never
  // rendered.
  //
  // §2 — the `ready` key boundary is now `synced`, not `yText != null`.
  // We remount once the INITIAL SYNC lands (so the seeded doc reflects
  // the server's authoritative content), not merely when the provider is
  // constructed. Same remount contract, later — and correct — trigger.
  const inner = uploadPageId ?? pageId ?? 'collab';
  return (
    <MarkdownEditor
      key={`${inner}-${ready ? 'ready' : 'pending'}`}
      ref={ref}
      value=""
      getInitialDoc={ready && yText ? () => yText.toString() : undefined}
      readonly={editorReadonly}
      disableHistory={ready}
      extraExtensions={extraExtensions}
      paste={uploadConfig}
      dnd={uploadConfig}
      linkCardEnabled={linkCardEnabled}
      className={className}
      aria-label={ariaLabel}
    />
  );
});
