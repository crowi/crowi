'use client';

import { useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { AlertCircle, Loader2, Save, X } from 'lucide-react';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Textarea } from '@/components/ui/textarea';
import { LoadingSpinner } from '@/components/ui/loading-spinner';
import { usePage } from '@/lib/use-page';
import { PageRevisionConflictError, useCreatePage, useUpdatePage } from '@/lib/use-page-mutations';

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
    <Card>
      <CardHeader>
        <CardTitle>Invalid editor parameters</CardTitle>
        <CardDescription>page_id か path のいずれかをクエリで指定してください。</CardDescription>
      </CardHeader>
      <CardContent>
        <Button variant="outline" onClick={() => router.back()}>
          Go Back
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
}

function EditorShell({ title, subtitle, body, onChangeBody, onSave, onCancel, isSaving, feedback }: EditorShellProps) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>{title}</CardTitle>
        <CardDescription className="truncate">{subtitle}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {feedback && (
          <Alert variant="destructive">
            <AlertCircle className="h-4 w-4" />
            <AlertTitle>{feedback.kind === 'conflict' ? '編集が競合しました' : 'エラー'}</AlertTitle>
            <AlertDescription>{feedback.message}</AlertDescription>
          </Alert>
        )}

        <Textarea
          value={body}
          onChange={(event) => onChangeBody(event.target.value)}
          disabled={isSaving}
          placeholder="Markdown で本文を入力..."
          className="font-mono min-h-[60vh]"
          aria-label="Page body"
        />

        <div className="flex items-center justify-end gap-2">
          <Button variant="outline" onClick={onCancel} disabled={isSaving} type="button">
            <X className="h-4 w-4 mr-1" />
            Cancel
          </Button>
          <Button variant="default" onClick={onSave} disabled={isSaving} type="button">
            {isSaving ? <Loader2 className="h-4 w-4 mr-1 animate-spin" /> : <Save className="h-4 w-4 mr-1" />}
            Save
          </Button>
        </div>
      </CardContent>
    </Card>
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
      setFeedback({ kind: 'error', message: err instanceof Error ? err.message : 'Failed to update page' });
    }
  };

  if (isLoading) {
    return <LoadingSpinner message="Loading page..." />;
  }

  if (isError || !page) {
    return (
      <Alert variant="destructive">
        <AlertCircle className="h-4 w-4" />
        <AlertTitle>Error</AlertTitle>
        <AlertDescription>
          ページを読み込めませんでした。{error?.message ?? ''}
          <div className="mt-3">
            <Button variant="outline" size="sm" onClick={() => router.back()}>
              Go Back
            </Button>
          </div>
        </AlertDescription>
      </Alert>
    );
  }

  return (
    <EditorShell
      title="ページを編集"
      subtitle={page.path}
      body={body ?? ''}
      onChangeBody={setBody}
      onSave={handleSave}
      onCancel={handleCancel}
      isSaving={updateMutation.isPending}
      feedback={feedback}
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
      setFeedback({ kind: 'error', message: err instanceof Error ? err.message : 'Failed to create page' });
    }
  };

  return (
    <EditorShell
      title="新しいページを作成"
      subtitle={path}
      body={body}
      onChangeBody={setBody}
      onSave={handleSave}
      onCancel={() => router.back()}
      isSaving={createMutation.isPending}
      feedback={feedback}
    />
  );
}
