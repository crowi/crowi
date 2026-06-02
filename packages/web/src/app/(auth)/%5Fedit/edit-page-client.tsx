'use client';

import { m } from '@paraglide/messages.js';
import { AlertCircle, Loader2, Save, X } from 'lucide-react';
import { useRouter, useSearchParams } from 'next/navigation';
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { toast } from 'sonner';
import type * as Y from 'yjs';
import { CollabForceReloadDialog } from '@/components/editor/CollabForceReloadDialog';
import { CollaborativeMarkdownEditor, type CollabSession, useCollabSession } from '@/components/editor/CollaborativeMarkdownEditor';
import { CollabPresenceAvatars } from '@/components/editor/CollabPresenceAvatars';
import { CollabSameBlockWarning } from '@/components/editor/CollabSameBlockWarning';
import { GrantSelect } from '@/components/editor/GrantSelect';
import { MarkdownEditor, type MarkdownEditorHandle } from '@/components/editor/MarkdownEditor';
import { MarkdownPreview } from '@/components/editor/MarkdownPreview';
import { SessionReauthModal } from '@/components/editor/session-reauth-modal';
import { SessionReauthProvider } from '@/lib/session-reauth-context';
import { UnsavedChangesDialog } from '@/components/editor/UnsavedChangesDialog';
import { AttachmentInsertButton } from '@/components/page-edit/attachment-insert-button';
import { DraftConflictAlert } from '@/components/page-edit/draft-conflict-alert';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { ErrorAlert } from '@/components/ui/error-alert';
import { LoadingSpinner } from '@/components/ui/loading-spinner';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { pageDisplayName } from '@/lib/page-path';
import { useAuth } from '@/lib/use-auth';
import type { CollabStatus } from '@/lib/use-collab-document';
import { useCollabSave } from '@/lib/use-collab-save';
import { DraftPathConflictError, draftEditHref, useCreateDraft, useDrafts } from '@/lib/use-drafts';
import { usePage } from '@/lib/use-page';
import { PageRevisionConflictError, useSetPageGrant, useUpdatePage } from '@/lib/use-page-mutations';
import { usePageTitle } from '@/lib/use-page-title';
import { usePresence } from '@/lib/use-presence';
import { useScrollSync } from '@/lib/use-scroll-sync';

type Feedback = { kind: 'conflict' | 'error'; message: string };

/**
 * Fixed sonner toast id used by the collab status notifications.
 * Reusing the same id means a fresh `toast.*` call replaces the
 * previous offline/reconnected/auth-failed toast in place instead of
 * stacking new ones every time the connection cycles.
 */
const COLLAB_STATUS_TOAST_ID = 'collab-status';

type EditMode = { kind: 'update'; pageId: string } | { kind: 'create'; path: string } | { kind: 'invalid' };

function resolveMode(pageId: string | null, path: string | null): EditMode {
  if (pageId) return { kind: 'update', pageId };
  if (path) return { kind: 'create', path };
  return { kind: 'invalid' };
}

// `useSyncExternalStore` adapters for the `md`-breakpoint media query.
// File-scope so React can refer to stable function identities across
// renders (the hook re-subscribes if `subscribe` changes identity).
// Mirrors Tailwind's `md` token (768px) — see `tailwind.config`.
const WIDE_QUERY = '(min-width: 768px)';
function subscribeWideQuery(callback: () => void): () => void {
  const mql = window.matchMedia(WIDE_QUERY);
  mql.addEventListener('change', callback);
  return () => mql.removeEventListener('change', callback);
}
function getWideQuerySnapshot(): boolean {
  return window.matchMedia(WIDE_QUERY).matches;
}
function getWideQueryServerSnapshot(): boolean {
  // SSR default: render the narrow layout. The client effect promotes
  // to wide on hydration if the viewport is large.
  return false;
}

export function EditPageClient() {
  const searchParams = useSearchParams();
  const mode = resolveMode(searchParams.get('page_id'), searchParams.get('path'));

  if (mode.kind === 'invalid') return <InvalidParamsView />;
  if (mode.kind === 'update') return <UpdatePageEditor pageId={mode.pageId} />;
  return <CreatePageEditor path={mode.path} />;
}

function InvalidParamsView() {
  const router = useRouter();
  return (
    <div className="flex flex-1 items-center justify-center p-4">
      <Card className="w-full max-w-4xl">
        <CardHeader>
          <CardTitle>{m['edit.invalid_params_title']()}</CardTitle>
          <CardDescription>{m['edit.invalid_params_description']()}</CardDescription>
        </CardHeader>
        <CardContent>
          <Button variant="outline" onClick={() => router.back()}>
            {m['common.go_back']()}
          </Button>
        </CardContent>
      </Card>
    </div>
  );
}

interface EditorShellProps {
  title: string;
  subtitle: string;
  body: string;
  onChangeBody: (value: string) => void;
  onSave: () => void;
  onCancel: () => void;
  isSaving: boolean;
  feedback: Feedback | null;
  /**
   * The page id to attach files to. `null` for create-mode (page hasn't
   * been saved yet) — the attach button is rendered but disabled in
   * that case, with a tooltip prompting the user to save first.
   */
  pageId: string | null;
  /** Called by the attach button to surface upload errors as Feedback. */
  onAttachError: (message: string) => void;
  /**
   * RFC-0003 Phase 7 — when supplied, both editor panes mount the
   * realtime `CollaborativeMarkdownEditor` (Yjs / Hocuspocus) instead
   * of the bare `MarkdownEditor`. `body` then becomes a passive mirror
   * the parent updates via `onChangeBody` on `onYTextChange`; the
   * `value` / `onChange` path through CodeMirror is bypassed because
   * yCollab owns the doc directly. Pass `null` for the create flow
   * (no page id yet → no token → no realtime).
   */
  realtimePageId?: string | null;
  /**
   * Notified when the collab readonly state flips (token says cap
   * reached, or auth fails). Caller surfaces the banner + disables
   * save.
   */
  onReadonlyChange?: (readonly: boolean) => void;
  /**
   * `true` when the realtime layer flagged the session as read-only.
   * Drives the save-button disable + the read-only banner.
   */
  readonly?: boolean;
  /**
   * RFC-0003 Phase 8 — when `true`, the EditorShell uses the realtime
   * Save flow (`crowi:save` over Hocuspocus stateless) instead of the
   * HTTP `onSave` mutation. The `onSave` prop is then ignored.
   *
   * We intentionally surface this as a boolean (not a function) so the
   * shell can also drive the `same-paragraph` warning + force-reload
   * dialog from the same `session` it already manages internally —
   * keeping the realtime UX state co-located is cleaner than threading
   * 4 more props through the parent.
   */
  useRealtimeSave?: boolean;
  /**
   * RFC-0005 Phase 2 — page visibility (grant) controls. When `grant`
   * is supplied the header renders the `GrantSelect`; `onChangeGrant`
   * persists the new value. Omitted by the create flow before a draft
   * page id exists (the draft is always GRANT_PUBLIC then).
   */
  grant?: number;
  onChangeGrant?: (grant: number) => void;
  /** `true` while a grant mutation is in flight (disables the selector). */
  isGrantSaving?: boolean;
}

function EditorShell({
  title,
  subtitle,
  body,
  onChangeBody,
  onSave,
  onCancel,
  isSaving,
  feedback,
  pageId,
  onAttachError,
  realtimePageId,
  onReadonlyChange,
  readonly = false,
  useRealtimeSave = false,
  grant,
  onChangeGrant,
  isGrantSaving = false,
}: EditorShellProps) {
  // RFC-0003 Phase 7: a single Hocuspocus connection (= one Y.Doc +
  // one provider) is shared by the wide + narrow editor panes. Both
  // panes stay mounted in the DOM at all times (CSS `display: none`
  // toggle); without sharing the session each pane would open its
  // own WebSocket. `useCollabSession(null)` is the no-op branch for
  // the create flow where `realtimePageId` is null.
  const session = useCollabSession(realtimePageId);
  // Phase 8 Save flow: when realtime save is enabled the spinner +
  // disabled state of the Save button is driven by `useCollabSave`'s
  // in-flight state instead of the HTTP mutation's `isPending`.
  const collabSave = useCollabSave(useRealtimeSave ? session : null);
  // Phase 8 force-reload dialog: open + reason are driven by the
  // `onForceReload` callback we hand to CollaborativeMarkdownEditor.
  // We keep the state here in the shell (rather than the parent
  // editors) because the dialog needs the same lifetime as the
  // session — the moment the user reloads, both vanish together.
  const [forceReload, setForceReload] = useState<{ open: boolean; reason?: string }>({ open: false });
  const handleForceReload = useCallback((reason?: string) => {
    setForceReload({ open: true, reason });
  }, []);

  // Unsaved-changes tracking. Two flavours:
  //   - realtime save (Y.Text local mutations since last `crowi:save` ok)
  //   - HTTP save     (caller-side body string non-empty / divergent)
  // The dirty signal drives both the browser `beforeunload` guard and
  // the in-app cancel-button dialog. We reset realtime-dirty on every
  // successful save; HTTP dirty is recomputed from props each render.
  const [realtimeDirty, setRealtimeDirty] = useState(false);
  useEffect(() => {
    if (!useRealtimeSave) return;
    const yText = session.yText;
    if (!yText) return;
    const observer = (_event: Y.YTextEvent, transaction: Y.Transaction): void => {
      if (!transaction.local) return;
      setRealtimeDirty(true);
    };
    yText.observe(observer);
    return () => {
      yText.unobserve(observer);
    };
  }, [useRealtimeSave, session.yText]);
  const isDirty = useRealtimeSave ? realtimeDirty : body.length > 0;

  const [unsavedDialogOpen, setUnsavedDialogOpen] = useState(false);

  // Browser-level guard for tab close / refresh / external-link
  // navigation. Modern browsers ignore the custom message but still
  // show their default "Leave site?" prompt as long as we call
  // `preventDefault()` / set `returnValue`. Skip the listener when
  // there's nothing to protect so we don't add a no-op handler to
  // every keystroke-induced render.
  useEffect(() => {
    if (!isDirty) return;
    const handler = (e: BeforeUnloadEvent): void => {
      e.preventDefault();
      // Set a non-empty string for older browsers that still surface
      // it; modern Chrome/Safari/Firefox replace it with their own
      // generic prompt regardless of the value.
      e.returnValue = m['edit.unsaved_beforeunload']();
    };
    window.addEventListener('beforeunload', handler);
    return () => window.removeEventListener('beforeunload', handler);
  }, [isDirty]);

  // Wraps the parent's `onCancel` with a dirty check. The dialog
  // arms a "save → exit", "discard → exit", or "stay" branch; only
  // the bottom two routes actually run `onCancel`.
  const handleCancelClick = useCallback(() => {
    if (isDirty) {
      setUnsavedDialogOpen(true);
      return;
    }
    onCancel();
  }, [isDirty, onCancel]);

  const handleDialogSave = useCallback(() => {
    if (useRealtimeSave) {
      collabSave
        .save()
        .then(() => {
          setRealtimeDirty(false);
          setUnsavedDialogOpen(false);
          toast.success(m['collab.save_success']());
          onCancel();
        })
        .catch((err: { message?: string }) => {
          toast.error(m['collab.save_failed']({ message: err?.message ?? '' }));
          setUnsavedDialogOpen(false);
        });
      return;
    }
    // HTTP mode: the parent's `onSave` performs the mutation + handles
    // its own navigation (redirect to the new/updated page). Closing the
    // dialog optimistically is fine — if the mutation surfaces an error
    // via the `feedback` prop, the user is back on the editor with the
    // dirty body intact and can retry.
    onSave();
    setUnsavedDialogOpen(false);
  }, [useRealtimeSave, collabSave, onCancel, onSave]);

  const handleDialogDiscard = useCallback(() => {
    setUnsavedDialogOpen(false);
    onCancel();
  }, [onCancel]);
  // Collab status toasts: a 'disconnected' surfaces a persistent offline
  // error toast; the first 'connected' after that replaces it with a
  // 'reconnected' confirmation; 'auth-failed' is terminal.
  const prevStatusRef = useRef<CollabStatus>('connecting');
  // Whether the persistent offline toast is currently showing. A
  // reconnect goes 'disconnected' → 'connecting' → 'connected', so the
  // recovery toast must key off "was offline" rather than the
  // immediately-previous status (which is 'connecting', not
  // 'disconnected', by the time 'connected' arrives).
  const wasOfflineRef = useRef(false);
  useEffect(() => {
    if (!realtimePageId) return;
    const prev = prevStatusRef.current;
    const next = session.status;
    if (next === prev) return;
    prevStatusRef.current = next;
    if (next === 'disconnected') {
      wasOfflineRef.current = true;
      toast.error(m['edit.connection_offline'](), {
        id: COLLAB_STATUS_TOAST_ID,
        duration: Infinity,
      });
    } else if (next === 'connected' && wasOfflineRef.current) {
      wasOfflineRef.current = false;
      toast.success(m['edit.connection_reconnected'](), {
        id: COLLAB_STATUS_TOAST_ID,
        duration: 3000,
      });
    } else if (next === 'auth-failed') {
      toast.error(m['edit.connection_auth_failed'](), {
        id: COLLAB_STATUS_TOAST_ID,
        duration: Infinity,
      });
    }
  }, [realtimePageId, session.status]);

  // Two editor refs because wide (md+ grid) and narrow (Tabs) each mount
  // their own `MarkdownEditor` — both panels live in the DOM at all
  // times (`md:` only toggles `display`), so sharing one ref would let
  // the later-mounting instance silently overwrite the earlier one,
  // and the "active" ref would always point at the `display: none`
  // pane (no scroll, no overflow → scroll-sync silently dies).
  const wideEditorRef = useRef<MarkdownEditorHandle>(null);
  const narrowEditorRef = useRef<MarkdownEditorHandle>(null);
  // Wide-only preview scroll ref. The narrow Tabs view only ever shows
  // one pane at a time, so cross-pane sync there would be invisible.
  const widePreviewScrollRef = useRef<HTMLDivElement>(null);
  // Narrow-viewport tab state. We control `Tabs` so the inactive
  // preview pane can skip its debounced fetch instead of running it
  // in the background where the user can't see it. Wide viewports
  // ignore this and always render both panes side-by-side.
  const [narrowTab, setNarrowTab] = useState<'editor' | 'preview'>('editor');
  // Track whether the wide layout is active so scroll sync only binds
  // when both panes are on screen. `useSyncExternalStore` keeps SSR
  // safe (server snapshot returns the narrow default) and avoids the
  // "setState in effect" cascading-render lint warning. Mirrors the
  // pattern `page-content.tsx` uses to subscribe to the URL hash.
  const isWide = useSyncExternalStore(subscribeWideQuery, getWideQuerySnapshot, getWideQueryServerSnapshot);

  useScrollSync({ editorRef: wideEditorRef, previewRef: widePreviewScrollRef, enabled: isWide });

  /**
   * Hand a markdown snippet to the editor's `insertAtCursor` handle —
   * the imperative API mirrors what `attachment-insert-button` used
   * with the old `<textarea>` (cursor-position insert, then focus
   * restoration). State stays in the parent via the CodeMirror
   * `updateListener` → `onChangeBody` bridge, so we don't have to
   * thread the resulting body string back ourselves.
   */
  const insertAtCursor = (snippet: string): void => {
    // Route to whichever editor is currently visible. Both panels are
    // mounted (forceMount + `md:` toggle), but only one has user
    // focus + a visible caret — operating the hidden one would drop
    // the snippet into a `display: none` subtree.
    const handle = (isWide ? wideEditorRef : narrowEditorRef).current;
    if (!handle) {
      // Defensive fallback: if the editor hasn't mounted yet (should
      // not happen because the button lives inside the same shell),
      // append to the end through the parent setter so the snippet
      // isn't dropped.
      onChangeBody(body + snippet);
      return;
    }
    handle.insertAtCursor(snippet);
  };

  // Full-viewport flex layout: title-bar at top, attach/save bar at
  // bottom, editor + preview filling the gap. Parent `EditLayout`
  // sets `h-[calc(100dvh-3.5rem)] overflow-hidden`, so this column
  // claims that height and each pane owns its own scroll. The
  // header/footer don't need `position: sticky` because the parent
  // doesn't scroll — flex order + `shrink-0` keeps them pinned.
  return (
    <div className="flex h-full min-h-0 flex-1 flex-col">
      <header className="bg-background z-10 shrink-0 border-b px-4 py-3 md:px-6">
        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0 flex-1">
            <h2 className="text-lg font-semibold leading-tight">{title}</h2>
            <p className="text-muted-foreground truncate text-sm">{subtitle}</p>
          </div>
          <div className="flex shrink-0 items-center gap-3">
            {grant !== undefined && onChangeGrant && <GrantSelect value={grant} onChange={onChangeGrant} disabled={isGrantSaving || readonly} />}
            {realtimePageId && <CollabPresenceAvatars awareness={session.awareness} localClientId={session.awareness?.clientID ?? null} />}
          </div>
        </div>
        {feedback && (
          <Alert variant="destructive" className="mt-3">
            <AlertCircle className="h-4 w-4" />
            <AlertTitle>{feedback.kind === 'conflict' ? m['edit.feedback_conflict_title']() : m['edit.feedback_error_title']()}</AlertTitle>
            <AlertDescription>{feedback.message}</AlertDescription>
          </Alert>
        )}
      </header>

      {/* Wide (md+): 2 columns side-by-side; narrow: Tabs with both
          panels mounted (Radix `forceMount`) so switching tabs
          doesn't unmount the CodeMirror view + lose the buffer.
          `active` is forwarded to the narrow preview so its
          debounced fetch only fires when the user is looking at it. */}
      <main className="flex min-h-0 flex-1 flex-col overflow-hidden px-4 py-3 md:px-6">
        {/* Both branches are always in the DOM (only `md:` toggles
            display), so the wide PreviewPane is `active={isWide}` —
            otherwise on a narrow viewport it would fire its 250ms
            debounced fetch every keystroke alongside the narrow one.
            `grid-rows-1` (= `grid-template-rows: minmax(0, 1fr)`) is
            REQUIRED for `h-full` to propagate to grid items: without
            it the row defaults to `auto` (content-fit) and the chain
            `grid-item h-full → .cm-editor h-full → .cm-scroller 100%`
            collapses to 0, killing CodeMirror's internal scroll. */}
        <div className="hidden h-full min-h-0 md:grid md:grid-cols-2 md:grid-rows-1 md:gap-4">
          <EditorPane
            ref={wideEditorRef}
            value={body}
            onChange={onChangeBody}
            readonly={isSaving || readonly}
            ariaLabel={m['edit.aria_body']()}
            realtimePageId={realtimePageId ?? null}
            session={realtimePageId ? session : null}
            onReadonlyChange={onReadonlyChange}
            // Subscribe on the wide pane only — both panes share the
            // same `session`'s stateless fan-out, so attaching twice
            // would fire the handler twice for one broadcast.
            onForceReload={handleForceReload}
          />
          <PreviewPane source={body} scrollRef={widePreviewScrollRef} active={isWide} />
        </div>
        <Tabs value={narrowTab} onValueChange={(v) => setNarrowTab(v as 'editor' | 'preview')} className="flex h-full min-h-0 flex-col md:hidden">
          <TabsList className="w-full shrink-0">
            <TabsTrigger value="editor" className="flex-1">
              {m['edit.tab_editor']()}
            </TabsTrigger>
            <TabsTrigger value="preview" className="flex-1">
              {m['edit.tab_preview']()}
            </TabsTrigger>
          </TabsList>
          <TabsContent value="editor" forceMount className="mt-2 min-h-0 flex-1 data-[state=inactive]:hidden">
            <EditorPane
              ref={narrowEditorRef}
              value={body}
              onChange={onChangeBody}
              readonly={isSaving || readonly}
              ariaLabel={m['edit.aria_body']()}
              realtimePageId={realtimePageId ?? null}
              session={realtimePageId ? session : null}
              onReadonlyChange={onReadonlyChange}
            />
          </TabsContent>
          <TabsContent value="preview" forceMount className="mt-2 min-h-0 flex-1 data-[state=inactive]:hidden">
            <PreviewPane source={body} active={!isWide && narrowTab === 'preview'} />
          </TabsContent>
        </Tabs>
      </main>

      {readonly && (
        <div className="bg-amber-50 dark:bg-amber-950/40 border-t border-amber-200 dark:border-amber-900 px-4 py-2 text-sm text-amber-900 dark:text-amber-200 md:px-6">
          {m['edit.readonly_banner']()}
        </div>
      )}

      <footer className="bg-background z-10 flex shrink-0 items-center justify-between gap-2 border-t px-4 py-3 md:px-6">
        <div className="flex items-center gap-3">
          <AttachmentInsertButton pageId={pageId} onInsert={insertAtCursor} onError={onAttachError} />
          {/* Phase 8 — subtle same-paragraph indicator next to the
              attach button so it shares the footer's secondary-action
              column. Renders null when no peer overlap, so the layout
              collapses cleanly in the common case. */}
          {realtimePageId && <CollabSameBlockWarning awareness={session.awareness} yText={session.yText} localClientId={session.awareness?.clientID ?? null} />}
        </div>
        <div className="flex items-center gap-2">
          <Button variant="outline" onClick={handleCancelClick} disabled={isSaving || collabSave.isSaving} type="button">
            <X className="mr-1 h-4 w-4" />
            {m['edit.cancel']()}
          </Button>
          {useRealtimeSave ? (
            <Button
              variant="default"
              onClick={() => {
                collabSave
                  .save()
                  .then(() => {
                    setRealtimeDirty(false);
                    toast.success(m['collab.save_success']());
                  })
                  .catch((err: { message?: string }) => {
                    toast.error(m['collab.save_failed']({ message: err?.message ?? '' }));
                  });
              }}
              disabled={collabSave.isSaving || readonly || session.status !== 'connected'}
              type="button"
            >
              {collabSave.isSaving ? <Loader2 className="mr-1 h-4 w-4 animate-spin" /> : <Save className="mr-1 h-4 w-4" />}
              {m['edit.save']()}
            </Button>
          ) : (
            <Button variant="default" onClick={onSave} disabled={isSaving || readonly} type="button">
              {isSaving ? <Loader2 className="mr-1 h-4 w-4 animate-spin" /> : <Save className="mr-1 h-4 w-4" />}
              {m['edit.save']()}
            </Button>
          )}
        </div>
      </footer>

      <UnsavedChangesDialog
        open={unsavedDialogOpen}
        onOpenChange={setUnsavedDialogOpen}
        onSave={handleDialogSave}
        onDiscard={handleDialogDiscard}
        isSaving={isSaving || collabSave.isSaving}
      />

      {/* Phase 8 — force-reload AlertDialog. Driven by the stateless
          listener we attached above; the dialog is `open` only after
          the server has broadcast `crowi:force-reload`, and the user
          must explicitly click "Reload" — we don't auto-reload to
          give them a chance to copy any local unsaved text out. */}
      <CollabForceReloadDialog open={forceReload.open} reason={forceReload.reason} />
    </div>
  );
}

interface EditorPaneProps {
  value: string;
  onChange: (next: string) => void;
  readonly: boolean;
  ariaLabel: string;
  /**
   * RFC-0003 Phase 7 — when set, this pane mounts the realtime collab
   * editor (`CollaborativeMarkdownEditor`) keyed by the page id and
   * sources `value` from Y.Text via the wrapper's `onYTextChange`
   * callback. The pane forwards that string to the parent via
   * `onChange` so the preview + attachment-insert flows continue to
   * see a plain `body` string. Pass `null` for the create flow.
   */
  realtimePageId: string | null;
  /**
   * Pre-built collab session shared across the wide + narrow panes so
   * a single Hocuspocus WebSocket feeds both editor mounts. When
   * `realtimePageId` is `null` this is also `null`.
   */
  session: CollabSession | null;
  /** Forwarded to the realtime wrapper; ignored in non-realtime mode. */
  onReadonlyChange?: (readonly: boolean) => void;
  /**
   * Forwarded to the realtime wrapper so the shell can listen for
   * `crowi:force-reload` on the stateless channel. Only the wide pane
   * subscribes — both panes share the same Hocuspocus listener fan-
   * out via `subscribeStateless`, so attaching twice would fire the
   * handler twice for one server-side broadcast.
   */
  onForceReload?: (reason?: string) => void;
}

const EditorPane = function EditorPane({
  value,
  onChange,
  readonly,
  ariaLabel,
  realtimePageId,
  session,
  onReadonlyChange,
  onForceReload,
  ref,
}: EditorPaneProps & { ref: React.Ref<MarkdownEditorHandle> }) {
  // Same className for both branches so layout + scroll behaviour
  // stay byte-identical. The collab wrapper forwards it to the inner
  // `MarkdownEditor`'s `<div>` wrapper.
  const editorClassName =
    'border-input bg-background focus-within:ring-ring h-full min-h-0 overflow-hidden rounded-md border font-mono text-sm focus-within:ring-1 [&_.cm-editor]:h-full [&_.cm-editor]:outline-none [&_.cm-focused]:outline-none [&_.cm-scroller]:scroll-auto [&_.cm-scroller]:p-3';

  if (realtimePageId && session) {
    return (
      <CollaborativeMarkdownEditor
        ref={ref}
        session={session}
        aria-label={ariaLabel}
        className={editorClassName}
        // RFC-0004: the session-driven variant has no `pageId` prop, so
        // the paste / drag-and-drop upload handlers need `uploadPageId`
        // passed explicitly — without it `uploadConfig` is undefined and
        // both handlers stay detached.
        uploadPageId={realtimePageId}
        // yText → body mirror so the preview + attachment markdown
        // insertion paths keep working without a Y.Text dependency.
        onYTextChange={onChange}
        onReadonlyChange={onReadonlyChange}
        onForceReload={onForceReload}
      />
    );
  }

  return (
    <MarkdownEditor
      ref={ref}
      value={value}
      onChange={onChange}
      readonly={readonly}
      aria-label={ariaLabel}
      // `[&_.cm-scroller]:scroll-auto` overrides `<html class="scroll-smooth">`
      // — required for scroll sync, otherwise programmatic scrolls
      // animate over several frames and re-emit `scroll` events past
      // the rAF lock window in `useScrollSync`, causing ping-pong sync.
      className={editorClassName}
    />
  );
};

function PreviewPane({
  source,
  active = true,
  scrollRef,
}: {
  source: string;
  active?: boolean;
  /**
   * Forwarded to the scroll container so `useScrollSync` can attach
   * a `scroll` listener and walk `[data-source-line]` markers
   * inside it. Only the wide-layout instance supplies a ref; the
   * narrow Tabs instance leaves it unset.
   */
  scrollRef?: React.Ref<HTMLDivElement>;
}) {
  return (
    // `scroll-auto` overrides the global `<html class="scroll-smooth">`
    // for the same reason as the editor side — see the EditorPane note.
    <div ref={scrollRef} className="border-input bg-background h-full min-h-0 scroll-auto overflow-auto rounded-md border p-4">
      <MarkdownPreview source={source} active={active} />
    </div>
  );
}

interface UpdatePageEditorProps {
  pageId: string;
}

function UpdatePageEditor({ pageId }: UpdatePageEditorProps) {
  const router = useRouter();
  const { user } = useAuth();
  const { page, isLoading, isError, error } = usePage({ page_id: pageId });

  // RFC-0005 — register the editor on the page's presence channel. The
  // editor connects to /collab for editing; this also connects it to
  // /presence so the editor appears in the live presence row that page
  // *viewers* see, carrying the ✏️ editing badge (which `listViewers`
  // joins from the collab editing signal). Without this an editor is
  // absent from the presence channel and vanishes from viewers' rows.
  // The returned viewer list is intentionally unused here — the editor
  // shows peers via `CollabPresenceAvatars`, not this row.
  usePresence(pageId);

  usePageTitle(page ? m['doc_title.editing']({ path: pageDisplayName(page.path) }) : null);

  // RFC-0003 Phase 7: in realtime mode the canonical body lives in
  // Y.Text. We still keep a React-side `body` string for the preview
  // pane + the attachment-insert markdown + the (transitional) HTTP
  // save path. The string is rehydrated by `CollaborativeMarkdownEditor`'s
  // `onYTextChange` once the Yjs session loads, but we seed it with
  // the last-saved revision body so the preview isn't blank while the
  // wsToken round-trip is in flight (~100 ms warm).
  const [body, setBody] = useState<string | null>(null);
  const [revisionId, setRevisionId] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<Feedback | null>(null);
  const [readonly, setReadonly] = useState<boolean>(false);

  const updateMutation = useUpdatePage();
  const setGrantMutation = useSetPageGrant();
  const handleReadonlyChange = useCallback((next: boolean) => {
    setReadonly(next);
  }, []);

  // Re-init when the loaded page's revision changes (e.g., user navigates between edits).
  // Following the React docs pattern for "Adjusting some state when a prop changes",
  // this runs during render rather than in an effect — `set-state-in-effect` is the
  // discouraged variant.
  if (page && page.revision._id !== revisionId) {
    setBody(page.revision.body ?? '');
    setRevisionId(page.revision._id);
  }

  const handleCancel = () => {
    if (page) {
      router.push(page.path);
      return;
    }
    router.back();
  };

  // RFC-0005 Phase 2 — persist a visibility change immediately via the
  // grant-only endpoint (no revision push). The page query is
  // invalidated on success, so `page.grant` re-renders with the new
  // value. A failure surfaces inline; the selector reverts because it
  // is driven straight off the (unchanged) `page.grant`.
  const handleChangeGrant = async (nextGrant: number) => {
    if (!page || nextGrant === page.grant) return;
    setFeedback(null);
    try {
      await setGrantMutation.mutateAsync({ page_id: page._id, grant: nextGrant });
    } catch (err) {
      setFeedback({ kind: 'error', message: err instanceof Error ? err.message : m['edit.grant_update_failed']() });
    }
  };

  const handleSave = async () => {
    if (!page || body === null) return;

    setFeedback(null);

    try {
      const updated = await updateMutation.mutateAsync({
        page_id: page._id,
        body,
        revision_id: revisionId ?? undefined,
      });
      router.push(updated.path);
    } catch (err) {
      if (err instanceof PageRevisionConflictError) {
        setFeedback({ kind: 'conflict', message: err.message });
        return;
      }
      setFeedback({ kind: 'error', message: err instanceof Error ? err.message : m['edit.failed_to_update']() });
    }
  };

  if (isLoading) {
    return (
      <div className="flex flex-1 items-center justify-center">
        <LoadingSpinner message={m['edit.loading_page']()} />
      </div>
    );
  }

  if (isError || !page) {
    return (
      <div className="flex flex-1 items-center justify-center p-4">
        <Alert variant="destructive" className="w-full max-w-4xl">
          <AlertCircle className="h-4 w-4" />
          <AlertTitle>{m['common.error']()}</AlertTitle>
          <AlertDescription>
            {m['edit.failed_to_load_body']({ message: error?.message ?? '' })}
            <div className="mt-3">
              <Button variant="outline" size="sm" onClick={() => router.back()}>
                {m['common.go_back']()}
              </Button>
            </div>
          </AlertDescription>
        </Alert>
      </div>
    );
  }

  // Wrap the realtime editor in the session-reauth provider so a JWT
  // expiry shows an inline modal instead of the `(auth)` redirect (which
  // would unmount the Y.Doc + lose the unsaved buffer). The provider +
  // modal live *outside* `EditorShell`, so a reauth never remounts the
  // editor — the buffer survives. Only the Y.Doc-bearing update flow is
  // wrapped; the create flow (no page id yet) is out of scope.
  return (
    <SessionReauthProvider pageId={page._id} currentEmail={user?.email}>
      <EditorShell
        title={m['edit.title_update']()}
        subtitle={page.path}
        body={body ?? ''}
        onChangeBody={setBody}
        // HTTP save path kept as a fallback signature; the realtime
        // shell ignores `onSave` when `useRealtimeSave` is true.
        onSave={handleSave}
        onCancel={handleCancel}
        isSaving={updateMutation.isPending}
        feedback={feedback}
        pageId={page._id}
        onAttachError={(message) => setFeedback({ kind: 'error', message })}
        realtimePageId={page._id}
        onReadonlyChange={handleReadonlyChange}
        readonly={readonly}
        // Phase 8: in-flight edits land via `crowi:save` over Hocuspocus
        // — the HTTP path stays around for the create flow only.
        useRealtimeSave={true}
        grant={page.grant ?? 1}
        onChangeGrant={handleChangeGrant}
        isGrantSaving={setGrantMutation.isPending}
      />
      <SessionReauthModal />
    </SessionReauthProvider>
  );
}

interface CreatePageEditorProps {
  path: string;
}

/**
 * RFC-0005 Phase 3 (option A) — the `_edit?path=X` create flow.
 *
 * Instead of the legacy "create on save" path (which left the editor
 * with `pageId={null}` → no D&D upload, no realtime, no presence),
 * this mounts a *draft* page via `POST /pages/drafts` and immediately
 * `router.replace`s the URL to `_edit?page_id=<pageId>`. `EditPageClient`
 * then re-resolves the mode and renders `UpdatePageEditor`, so the new
 * page is edited with a real page id from the first keystroke.
 *
 * `replace` (not `push`) is deliberate: a reload of the resulting
 * `?path=` history entry would otherwise POST a second draft.
 *
 * Branches:
 *   - 201 → replace to the draft editor.
 *   - 409 + owner is the current user → an existing own draft; look it
 *     up in the drafts list and replace to it. (Re-opening `?path=` for
 *     a page you already started.)
 *   - 409 + owner is someone else → inline "being created by …".
 *   - 400 → inline error (published page exists / invalid path).
 */
function CreatePageEditor({ path }: CreatePageEditorProps) {
  const router = useRouter();
  const { user } = useAuth();
  usePageTitle(m['doc_title.new_page']({ path: pageDisplayName(path) }));
  const createDraft = useCreateDraft();
  // `useDrafts` is only consulted in the own-409 branch — it is cheap
  // (30s staleTime, shared cache) and lets us recover the page id of a
  // draft this user already started at `path`.
  const { data: draftsData } = useDrafts();
  const [error, setError] = useState<CreateDraftError | null>(null);
  // Page id of the draft once it exists (fresh `201` or a resolved
  // own-`409`). When set we render `UpdatePageEditor` directly rather
  // than waiting for `router.replace` to swap modes — see the comment
  // on `enterDraftEditor` below.
  const [draftPageId, setDraftPageId] = useState<string | null>(null);

  // The draft-creation POST fires exactly once; its *promise* is kept
  // in a ref. React StrictMode (dev) mounts effects twice — the first
  // mount issues the POST, then the component is torn down and
  // remounted. Holding the promise (not just a "started" boolean) lets
  // the remounted instance re-attach its own handler to the same
  // in-flight request. Without this the first mount's react-query
  // observer is destroyed before the POST resolves, its result
  // callbacks are silently dropped, and the editor stays stuck on the
  // "preparing" spinner even though the draft was created server-side.
  const draftPromiseRef = useRef<Promise<{ pageId: string }> | null>(null);

  // Switch this component into the draft editor.
  //
  // `router.replace` alone is NOT enough: it only changes the query
  // string on the *same* `/_edit` route, and a query-only navigation
  // does not reliably re-render `EditPageClient` against the new
  // `page_id` search param — `resolveMode` keeps returning `create`
  // and the "preparing" spinner spins forever even though the draft
  // was created. So we drive the mode switch from local state
  // (`draftPageId`) and use `replace` only to keep the URL honest for
  // reload / Back (a reload of `?path=` would otherwise POST a second
  // draft; `?page_id=` reloads straight into `UpdatePageEditor`).
  const enterDraftEditor = useCallback(
    (pageId: string) => {
      router.replace(draftEditHref(pageId));
      setDraftPageId(pageId);
    },
    [router],
  );

  useEffect(() => {
    // Issue the POST once (guarded by the ref); on a StrictMode
    // remount the ref already holds the promise, so we only re-attach
    // a fresh handler — never re-POST. The promise settles
    // independently of the react-query observer's lifecycle, so the
    // surviving mount always receives the result.
    if (!draftPromiseRef.current) {
      draftPromiseRef.current = createDraft.mutateAsync({ path });
    }
    let cancelled = false;
    draftPromiseRef.current
      .then(({ pageId }) => {
        if (!cancelled) enterDraftEditor(pageId);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        if (err instanceof DraftPathConflictError) {
          // Own existing draft → resolve its page id from the list
          // and hop straight into its editor.
          if (user && err.owner.id === user.id) {
            const own = draftsData?.drafts.find((d) => d.path === path);
            if (own) {
              enterDraftEditor(own.pageId);
              return;
            }
            // The list hasn't loaded the matching row yet — surface a
            // recoverable error rather than spin forever.
            setError({ kind: 'message', text: m['edit.draft_own_conflict_unresolved']() });
            return;
          }
          setError({ kind: 'conflict', displayName: err.owner.displayName, username: err.owner.username });
          return;
        }
        setError({ kind: 'message', text: err instanceof Error ? err.message : m['edit.failed_to_create']() });
      });
    return () => {
      cancelled = true;
    };
    // Run exactly once on mount. `path` is stable for a given editor
    // open (a new path = a fresh navigation = a fresh component), and
    // the other deps are intentionally excluded so a `draftsData`
    // refetch can't re-fire the POST.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Draft exists → render the real editor with its page id. This is
  // the direct mode switch that does not depend on the query-only
  // `router.replace` re-rendering `EditPageClient`.
  if (draftPageId) {
    return <UpdatePageEditor pageId={draftPageId} />;
  }

  if (error) {
    return (
      <div className="flex flex-1 items-center justify-center p-4">
        <Card className="w-full max-w-2xl">
          <CardHeader>
            <CardTitle>{m['edit.title_create']()}</CardTitle>
            <CardDescription className="font-mono">{path}</CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            {error.kind === 'conflict' ? <DraftConflictAlert displayName={error.displayName} username={error.username} /> : <ErrorAlert message={error.text} />}
            <Button variant="outline" onClick={() => router.back()}>
              {m['common.go_back']()}
            </Button>
          </CardContent>
        </Card>
      </div>
    );
  }

  // Default: the draft POST is in flight. On success `enterDraftEditor`
  // sets `draftPageId`, which renders `UpdatePageEditor` above — so
  // this spinner is only ever shown briefly.
  return (
    <div className="flex flex-1 items-center justify-center">
      <LoadingSpinner message={m['edit.creating_draft']()} />
    </div>
  );
}

/** Mutually exclusive failure states surfaced by the create flow. */
type CreateDraftError = { kind: 'conflict'; displayName: string; username: string } | { kind: 'message'; text: string };
