'use client';

import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { AlertCircle, Loader2, Save, X } from 'lucide-react';
import { toast } from 'sonner';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { LoadingSpinner } from '@/components/ui/loading-spinner';
import { AttachmentInsertButton } from '@/components/page-edit/attachment-insert-button';
import { MarkdownEditor, type MarkdownEditorHandle } from '@/components/editor/MarkdownEditor';
import { CollaborativeMarkdownEditor, useCollabSession, type CollabSession } from '@/components/editor/CollaborativeMarkdownEditor';
import { MarkdownPreview } from '@/components/editor/MarkdownPreview';
import { usePage } from '@/lib/use-page';
import { PageRevisionConflictError, useCreatePage, useUpdatePage } from '@/lib/use-page-mutations';
import { useScrollSync } from '@/lib/use-scroll-sync';
import type { CollabStatus } from '@/lib/use-collab-document';
import { m } from '@paraglide/messages.js';

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
}: EditorShellProps) {
  // RFC-0003 Phase 7: a single Hocuspocus connection (= one Y.Doc +
  // one provider) is shared by the wide + narrow editor panes. Both
  // panes stay mounted in the DOM at all times (CSS `display: none`
  // toggle); without sharing the session each pane would open its
  // own WebSocket. `useCollabSession(null)` is the no-op branch for
  // the create flow where `realtimePageId` is null.
  const session = useCollabSession(realtimePageId);
  // Collab status toasts: first 'disconnected' surfaces a persistent
  // error toast; first 'connected' after a drop confirms recovery;
  // 'auth-failed' is terminal and recommends a reload.
  const prevStatusRef = useRef<CollabStatus>('connecting');
  useEffect(() => {
    if (!realtimePageId) return;
    const prev = prevStatusRef.current;
    const next = session.status;
    if (next === prev) return;
    prevStatusRef.current = next;
    if (next === 'disconnected') {
      toast.error(m['edit.connection_offline'](), {
        id: COLLAB_STATUS_TOAST_ID,
        duration: Infinity,
      });
    } else if (next === 'connected' && prev === 'disconnected') {
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
        <h2 className="text-lg font-semibold leading-tight">{title}</h2>
        <p className="text-muted-foreground truncate text-sm">{subtitle}</p>
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
        <AttachmentInsertButton pageId={pageId} onInsert={insertAtCursor} onError={onAttachError} />
        <div className="flex items-center gap-2">
          <Button variant="outline" onClick={onCancel} disabled={isSaving} type="button">
            <X className="mr-1 h-4 w-4" />
            {m['edit.cancel']()}
          </Button>
          <Button variant="default" onClick={onSave} disabled={isSaving || readonly} type="button">
            {isSaving ? <Loader2 className="mr-1 h-4 w-4 animate-spin" /> : <Save className="mr-1 h-4 w-4" />}
            {m['edit.save']()}
          </Button>
        </div>
      </footer>
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
}

const EditorPane = function EditorPane({
  value,
  onChange,
  readonly,
  ariaLabel,
  realtimePageId,
  session,
  onReadonlyChange,
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
        // yText → body mirror so the preview + attachment markdown
        // insertion paths keep working without a Y.Text dependency.
        onYTextChange={onChange}
        onReadonlyChange={onReadonlyChange}
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
  const { page, isLoading, isError, error } = usePage({ page_id: pageId });

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

  return (
    <EditorShell
      title={m['edit.title_update']()}
      subtitle={page.path}
      body={body ?? ''}
      onChangeBody={setBody}
      onSave={handleSave}
      onCancel={handleCancel}
      isSaving={updateMutation.isPending}
      feedback={feedback}
      pageId={page._id}
      onAttachError={(message) => setFeedback({ kind: 'error', message })}
      realtimePageId={page._id}
      onReadonlyChange={handleReadonlyChange}
      readonly={readonly}
    />
  );
}

interface CreatePageEditorProps {
  path: string;
}

function CreatePageEditor({ path }: CreatePageEditorProps) {
  const router = useRouter();
  const [body, setBody] = useState<string>('');
  const [feedback, setFeedback] = useState<Feedback | null>(null);

  const createMutation = useCreatePage();

  const handleSave = async () => {
    setFeedback(null);
    try {
      const created = await createMutation.mutateAsync({ path, body });
      router.push(created.path);
    } catch (err) {
      setFeedback({ kind: 'error', message: err instanceof Error ? err.message : m['edit.failed_to_create']() });
    }
  };

  return (
    <EditorShell
      title={m['edit.title_create']()}
      subtitle={path}
      body={body}
      onChangeBody={setBody}
      onSave={handleSave}
      onCancel={() => router.back()}
      isSaving={createMutation.isPending}
      feedback={feedback}
      pageId={null}
      onAttachError={(message) => setFeedback({ kind: 'error', message })}
    />
  );
}
