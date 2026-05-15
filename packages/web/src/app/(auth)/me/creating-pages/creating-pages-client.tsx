'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { FileText, Loader2, Pencil, Plus, Trash2 } from 'lucide-react';
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { ErrorAlert } from '@/components/ui/error-alert';
import { Input } from '@/components/ui/input';
import { LoadingSpinner } from '@/components/ui/loading-spinner';
import { DraftPathConflictError, useCancelDraft, useCreateDraft, useDrafts } from '@/lib/use-drafts';
import { formatDistanceToNow } from '@/lib/date-utils';
import { notify } from '@/lib/notify';
import type { DraftSummary } from '@crowi/api-contract';
import { m } from '@paraglide/messages.js';

/** Editor route for a draft, by page id. Mirrors `_edit?page_id=`. */
function draftEditHref(pageId: string): string {
  return `/_edit?page_id=${encodeURIComponent(pageId)}`;
}

export function CreatingPagesClient() {
  return (
    <div className="space-y-6">
      <div>
        <h1 className="flex items-center gap-2 text-3xl font-bold">
          <FileText className="size-8" />
          {m['creating_pages.heading']()}
        </h1>
        <p className="text-muted-foreground mt-2">{m['creating_pages.subheading']()}</p>
      </div>

      <NewPageCard />
      <DraftsSection />
    </div>
  );
}

/** The user's draft list with its loading / error / empty states. */
function DraftsSection() {
  const { data, isLoading, isError } = useDrafts();

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-12">
        <LoadingSpinner message={m['creating_pages.loading']()} />
      </div>
    );
  }

  if (isError) {
    return <ErrorAlert message={m['creating_pages.failed_to_load']()} />;
  }

  const drafts = data?.drafts ?? [];
  return (
    <Card>
      <CardContent className="p-0">
        {drafts.length === 0 ? (
          <p className="text-muted-foreground p-6 text-sm">{m['creating_pages.empty']()}</p>
        ) : (
          <ul className="divide-y">
            {drafts.map((draft) => (
              <DraftRow key={draft.pageId} draft={draft} />
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}

/** Mutually exclusive failure states surfaced by the New page form. */
type NewPageError = { kind: 'conflict'; displayName: string; username: string } | { kind: 'message'; text: string };

/**
 * New page form. Submitting `POST`s a draft at the entered path:
 * 201 navigates to the draft editor; 409 (path held by another user's
 * draft) and 400 (invalid path) render an error inline.
 */
function NewPageCard() {
  const router = useRouter();
  const createDraft = useCreateDraft();
  const [path, setPath] = useState('');
  const [error, setError] = useState<NewPageError | null>(null);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = path.trim();
    setError(null);
    if (!trimmed) {
      setError({ kind: 'message', text: m['creating_pages.new_path_required']() });
      return;
    }
    createDraft.mutate(
      { path: trimmed },
      {
        onSuccess: ({ pageId }) => {
          router.push(draftEditHref(pageId));
        },
        onError: (err) => {
          if (err instanceof DraftPathConflictError) {
            setError({ kind: 'conflict', displayName: err.owner.displayName, username: err.owner.username });
            return;
          }
          setError({ kind: 'message', text: err instanceof Error ? err.message : m['creating_pages.new_failed']() });
        },
      },
    );
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-lg">{m['creating_pages.new_heading']()}</CardTitle>
        <CardDescription>{m['creating_pages.subheading']()}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <form onSubmit={handleSubmit} className="flex flex-col gap-2 sm:flex-row">
          <Input
            value={path}
            onChange={(e) => setPath(e.target.value)}
            placeholder={m['creating_pages.new_path_placeholder']()}
            aria-label={m['creating_pages.new_heading']()}
            className="font-mono"
            disabled={createDraft.isPending}
          />
          <Button type="submit" disabled={createDraft.isPending} className="shrink-0">
            {createDraft.isPending ? <Loader2 className="mr-1 h-4 w-4 animate-spin" /> : <Plus className="mr-1 h-4 w-4" />}
            {createDraft.isPending ? m['creating_pages.new_submit_pending']() : m['creating_pages.new_submit']()}
          </Button>
        </form>

        {error?.kind === 'conflict' && (
          <ErrorAlert
            title={m['creating_pages.conflict_title']()}
            message={m['creating_pages.conflict_message']({ displayName: error.displayName, username: error.username })}
          />
        )}
        {error?.kind === 'message' && <ErrorAlert message={error.text} />}
      </CardContent>
    </Card>
  );
}

function DraftRow({ draft }: { draft: DraftSummary }) {
  const router = useRouter();
  const cancelDraft = useCancelDraft();
  const [confirmOpen, setConfirmOpen] = useState(false);

  const handleCancel = () => {
    cancelDraft.mutate(draft.pageId, {
      onSuccess: () => {
        setConfirmOpen(false);
        notify.info(m['creating_pages.cancel_success']());
      },
      onError: (err) => {
        setConfirmOpen(false);
        notify.error(err instanceof Error ? err.message : m['creating_pages.cancel_failed']());
      },
    });
  };

  return (
    <li className="flex flex-col gap-3 p-4 sm:flex-row sm:items-center sm:justify-between">
      <div className="min-w-0">
        <p className="truncate font-mono text-sm font-medium">{draft.path}</p>
        <p className="text-muted-foreground text-xs">{m['creating_pages.started_label']({ when: formatDistanceToNow(draft.createdAt) })}</p>
      </div>
      <div className="flex shrink-0 gap-2">
        <Button variant="outline" size="sm" onClick={() => router.push(draftEditHref(draft.pageId))}>
          <Pencil className="mr-1 h-4 w-4" />
          {m['creating_pages.action_edit']()}
        </Button>
        <Button variant="outline" size="sm" onClick={() => setConfirmOpen(true)}>
          <Trash2 className="mr-1 h-4 w-4" />
          {m['creating_pages.action_cancel']()}
        </Button>
        {/* Controlled (no Trigger child): the row's Cancel button opens
            it, and the mutation callbacks close it — so the dialog stays
            open while the DELETE is in flight. */}
        <AlertDialog open={confirmOpen} onOpenChange={setConfirmOpen}>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>{m['creating_pages.cancel_dialog_title']()}</AlertDialogTitle>
              <AlertDialogDescription>{m['creating_pages.cancel_dialog_description']({ path: draft.path })}</AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel disabled={cancelDraft.isPending}>{m['creating_pages.cancel_dialog_keep']()}</AlertDialogCancel>
              {/* Not an AlertDialogAction: that auto-closes the dialog
                  on click, which would race the async mutation. We
                  close explicitly in the mutation callbacks instead. */}
              <Button variant="destructive" onClick={handleCancel} disabled={cancelDraft.isPending}>
                {cancelDraft.isPending ? <Loader2 className="mr-1 h-4 w-4 animate-spin" /> : <Trash2 className="mr-1 h-4 w-4" />}
                {m['creating_pages.cancel_dialog_confirm']()}
              </Button>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </div>
    </li>
  );
}
