'use client';

import { useRef, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { AlertCircle, Loader2, Save, X } from 'lucide-react';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { LoadingSpinner } from '@/components/ui/loading-spinner';
import { AttachmentInsertButton } from '@/components/page-edit/attachment-insert-button';
import { MarkdownEditor, type MarkdownEditorHandle } from '@/components/editor/MarkdownEditor';
import { MarkdownPreview } from '@/components/editor/MarkdownPreview';
import { usePage } from '@/lib/use-page';
import { PageRevisionConflictError, useCreatePage, useUpdatePage } from '@/lib/use-page-mutations';
import { m } from '@paraglide/messages.js';

type Feedback = { kind: 'conflict' | 'error'; message: string };

type EditMode = { kind: 'update'; pageId: string } | { kind: 'create'; path: string } | { kind: 'invalid' };

function resolveMode(pageId: string | null, path: string | null): EditMode {
  if (pageId) return { kind: 'update', pageId };
  if (path) return { kind: 'create', path };
  return { kind: 'invalid' };
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
    <Card className="max-w-4xl mx-auto">
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
}

function EditorShell({ title, subtitle, body, onChangeBody, onSave, onCancel, isSaving, feedback, pageId, onAttachError }: EditorShellProps) {
  const editorRef = useRef<MarkdownEditorHandle>(null);
  // Narrow-viewport tab state. We control `Tabs` so the inactive
  // preview pane can skip its debounced fetch instead of running it
  // in the background where the user can't see it. Wide viewports
  // ignore this and always render both panes side-by-side.
  const [narrowTab, setNarrowTab] = useState<'editor' | 'preview'>('editor');

  /**
   * Hand a markdown snippet to the editor's `insertAtCursor` handle —
   * the imperative API mirrors what `attachment-insert-button` used
   * with the old `<textarea>` (cursor-position insert, then focus
   * restoration). State stays in the parent via the CodeMirror
   * `updateListener` → `onChangeBody` bridge, so we don't have to
   * thread the resulting body string back ourselves.
   */
  const insertAtCursor = (snippet: string): void => {
    const handle = editorRef.current;
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

  return (
    <Card className="max-w-[1600px] mx-auto">
      <CardHeader>
        <CardTitle>{title}</CardTitle>
        <CardDescription className="truncate">{subtitle}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {feedback && (
          <Alert variant="destructive">
            <AlertCircle className="h-4 w-4" />
            <AlertTitle>{feedback.kind === 'conflict' ? m['edit.feedback_conflict_title']() : m['edit.feedback_error_title']()}</AlertTitle>
            <AlertDescription>{feedback.message}</AlertDescription>
          </Alert>
        )}

        {/* Wide (md+): 2 columns side-by-side; narrow: Tabs with both
            panels mounted (Radix `forceMount`) so switching tabs
            doesn't unmount the CodeMirror view + lose the buffer.
            `active` is forwarded to the narrow preview so its
            debounced fetch only fires when the user is looking at it. */}
        <div className="hidden md:grid md:grid-cols-2 md:gap-4">
          <EditorPane ref={editorRef} value={body} onChange={onChangeBody} readonly={isSaving} ariaLabel={m['edit.aria_body']()} />
          <PreviewPane source={body} />
        </div>
        <div className="md:hidden">
          <Tabs value={narrowTab} onValueChange={(v) => setNarrowTab(v as 'editor' | 'preview')}>
            <TabsList className="w-full">
              <TabsTrigger value="editor" className="flex-1">
                {m['edit.tab_editor']()}
              </TabsTrigger>
              <TabsTrigger value="preview" className="flex-1">
                {m['edit.tab_preview']()}
              </TabsTrigger>
            </TabsList>
            <TabsContent value="editor" forceMount className="data-[state=inactive]:hidden">
              <EditorPane ref={editorRef} value={body} onChange={onChangeBody} readonly={isSaving} ariaLabel={m['edit.aria_body']()} />
            </TabsContent>
            <TabsContent value="preview" forceMount className="data-[state=inactive]:hidden">
              <PreviewPane source={body} active={narrowTab === 'preview'} />
            </TabsContent>
          </Tabs>
        </div>

        <div className="flex items-center justify-between gap-2">
          <AttachmentInsertButton pageId={pageId} onInsert={insertAtCursor} onError={onAttachError} />
          <div className="flex items-center gap-2">
            <Button variant="outline" onClick={onCancel} disabled={isSaving} type="button">
              <X className="h-4 w-4 mr-1" />
              {m['edit.cancel']()}
            </Button>
            <Button variant="default" onClick={onSave} disabled={isSaving} type="button">
              {isSaving ? <Loader2 className="h-4 w-4 mr-1 animate-spin" /> : <Save className="h-4 w-4 mr-1" />}
              {m['edit.save']()}
            </Button>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

interface EditorPaneProps {
  value: string;
  onChange: (next: string) => void;
  readonly: boolean;
  ariaLabel: string;
}

const EditorPane = function EditorPane({ value, onChange, readonly, ariaLabel, ref }: EditorPaneProps & { ref: React.Ref<MarkdownEditorHandle> }) {
  return (
    <MarkdownEditor
      ref={ref}
      value={value}
      onChange={onChange}
      readonly={readonly}
      aria-label={ariaLabel}
      className="min-h-[60vh] rounded-md border border-input bg-background font-mono text-sm focus-within:ring-1 focus-within:ring-ring [&_.cm-editor]:min-h-[60vh] [&_.cm-editor]:outline-none [&_.cm-scroller]:p-3 [&_.cm-content]:min-h-[60vh] [&_.cm-focused]:outline-none"
    />
  );
};

function PreviewPane({ source, active = true }: { source: string; active?: boolean }) {
  return (
    <div className="min-h-[60vh] rounded-md border border-input bg-background p-4 overflow-auto">
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

  const [body, setBody] = useState<string | null>(null);
  const [revisionId, setRevisionId] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<Feedback | null>(null);

  const updateMutation = useUpdatePage();

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
    return <LoadingSpinner message={m['edit.loading_page']()} />;
  }

  if (isError || !page) {
    return (
      <Alert variant="destructive" className="max-w-4xl mx-auto">
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
