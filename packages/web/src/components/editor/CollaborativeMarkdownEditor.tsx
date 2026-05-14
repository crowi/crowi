'use client';

import { forwardRef, useEffect, useMemo } from 'react';
import type { Extension } from '@codemirror/state';
import { keymap } from '@codemirror/view';
import { yCollab } from 'y-codemirror.next';
import type * as Y from 'yjs';
import { CollabForceReloadMessageSchema } from '@crowi/api-contract';
import { userColor } from '@/lib/collab-user-color';
import type { CollabAwareness, StatelessListener } from '@/lib/use-collab-document';
import { useAuth } from '@/lib/use-auth';
import { useYjsToken } from '@/lib/use-yjs-token';
import { useCollabDocument, type CollabStatus } from '@/lib/use-collab-document';
import { MarkdownEditor, type MarkdownEditorHandle } from './MarkdownEditor';

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
   * Note: `yText.toString()` is O(n); for very large documents the
   * MarkdownPreview's 250 ms debounce absorbs the cost downstream,
   * but this is a candidate for throttling if profiling shows it
   * dominating keystroke latency (openQuestion 15 in the task).
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
  const tokenQuery = useYjsToken(pageId);
  const wsToken = tokenQuery.data?.wsToken ?? null;
  const tokenReadonly = tokenQuery.data?.readonly ?? false;
  const { yText, yUndoManager, awareness, status, readonly, setLocalAwareness, subscribeStateless, sendStateless } = useCollabDocument({
    pageId,
    wsToken,
    initialReadonly: tokenReadonly,
  });

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
  useEffect(() => {
    if (!awareness || isAuthLoading) return;
    if (!userId) {
      setLocalAwareness(null);
      return;
    }
    const palette = userColor(userId);
    setLocalAwareness({
      id: userId,
      name: userName?.trim() || (userUsername ?? userId),
      color: palette.color,
      colorLight: palette.colorLight,
    });
  }, [awareness, userId, userName, userUsername, isAuthLoading, setLocalAwareness]);

  return { yText, yUndoManager, awareness, status, readonly, subscribeStateless, sendStateless };
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
  const { pageId, session, className, 'aria-label': ariaLabel, onYTextChange, onStatusChange, onReadonlyChange, onForceReload } = props;

  // When the caller supplies a session, skip the internal hook
  // (otherwise we'd open a second WebSocket). React's rules require
  // unconditional hook calls, so we always invoke `useCollabSession`
  // and pass `null` for the disabled branch — the hook short-circuits
  // its own `useQuery` via the `enabled` flag.
  const ownedSession = useCollabSession(session ? null : pageId);
  const active = session ?? ownedSession;
  const { yText, yUndoManager, awareness, status, readonly, subscribeStateless } = active;

  // Build the CodeMirror extension list. `yCollab` is the bridge
  // that wires Y.Text ↔ EditorView (doc + selection); the explicit
  // keymap binds Mod-z / Mod-Shift-z to the Y.UndoManager so undo
  // stays Yjs-aware even though `disableHistory` strips the built-
  // in `historyKeymap`. We pass `[]` until the document is ready so
  // the editor can mount immediately with an empty doc and the user
  // sees the editor chrome rather than a spinner.
  const extraExtensions = useMemo<Extension[]>(() => {
    if (!yText || !awareness || !yUndoManager) return [];
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
  }, [yText, awareness, yUndoManager]);

  // Mirror Y.Text → caller's `body` string. The observer fires on
  // every local + remote update; downstream debounce (MarkdownPreview
  // 250 ms) absorbs the work. We emit one initial snapshot in case
  // `onLoadDocument` already populated Y.Text before this effect
  // attached its observer.
  useEffect(() => {
    if (!yText) return;
    const emit = () => onYTextChange?.(yText.toString());
    emit();
    yText.observe(emit);
    return () => {
      yText.unobserve(emit);
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

  // While Y.Text hasn't arrived yet we force readonly to avoid the
  // user typing into the empty mounted doc — those edits would
  // silently be dropped when yCollab attaches and overwrites the
  // EditorView's doc with Y.Text contents.
  const editorReadonly = readonly || !yText;

  // No `onChange`: yCollab owns dispatch, so the inner editor skips
  // the updateListener entirely (see `build-extensions.ts`).
  return (
    <MarkdownEditor
      ref={ref}
      value=""
      readonly={editorReadonly}
      disableHistory={Boolean(yText)}
      extraExtensions={extraExtensions}
      className={className}
      aria-label={ariaLabel}
    />
  );
});
