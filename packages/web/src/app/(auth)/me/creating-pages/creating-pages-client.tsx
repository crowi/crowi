'use client';

import type { DraftSummary } from '@crowi/api-contract';
import { m } from '@paraglide/messages.js';
import { FileText, Loader2, Pencil, Plus, Trash2, X } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
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
import { Card } from '@/components/ui/card';
import { DraftConflictAlert } from '@/components/page-edit/draft-conflict-alert';
import { ErrorAlert } from '@/components/ui/error-alert';
import { Input } from '@/components/ui/input';
import { formatDistanceToNow } from '@/lib/date-utils';
import { notify } from '@/lib/notify';
import { DraftPathConflictError, draftEditHref, useCancelDraft, useCreateDraft, useDrafts } from '@/lib/use-drafts';
import { usePageTitle } from '@/lib/use-page-title';

/**
 * "Pages you're creating" — your own unpublished drafts. Information
 * design differs from the public page list on purpose: drafts are
 * triage material ("what was I writing? is this stale? worth keeping?"),
 * so each row leads with the path and the two timestamps that frame
 * progress, with compact icon actions on the right.
 *
 * The "new page" creation form is folded behind a header button that
 * expands inline — it's used a few times a year per user, so reserving
 * a permanent card for it would waste vertical space above the list.
 */
export function CreatingPagesClient() {
  usePageTitle(m['creating_pages.heading']());
  const { data, isLoading, isError } = useDrafts();
  const drafts = data?.drafts ?? [];

  const [isFormOpen, setIsFormOpen] = useState(false);

  return (
    <div className="space-y-4">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <h1 className="flex items-center gap-2 text-2xl font-bold tracking-tight">
            <FileText className="size-6 text-muted-foreground" />
            {m['creating_pages.heading']()}
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">{m['creating_pages.subheading']()}</p>
        </div>
        <Button
          variant={isFormOpen ? 'outline' : 'default'}
          onClick={() => setIsFormOpen((open) => !open)}
          aria-expanded={isFormOpen}
          aria-label={isFormOpen ? m['creating_pages.new_page_button_close_aria']() : undefined}
          className="shrink-0"
        >
          {isFormOpen ? <X className="mr-1 h-4 w-4" /> : <Plus className="mr-1 h-4 w-4" />}
          {m['creating_pages.new_page_button']()}
        </Button>
      </div>

      {isFormOpen && <NewDraftForm onCreated={() => setIsFormOpen(false)} />}

      <DraftsSection drafts={drafts} isLoading={isLoading} isError={isError} />
    </div>
  );
}

/** Mutually exclusive failure states surfaced by the New page form. */
type NewPageError = { kind: 'conflict'; displayName: string; username: string } | { kind: 'message'; text: string };

/**
 * Inline expandable form panel for creating a new draft. Lives directly
 * under the page header — no Card wrapper, no duplicated description —
 * because the heading + subtitle already explain what this page is for.
 */
function NewDraftForm({ onCreated }: { onCreated?: () => void }) {
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
          onCreated?.();
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
    <div className="space-y-2 rounded-lg border bg-muted/30 p-3">
      <form onSubmit={handleSubmit} className="flex flex-col gap-2 sm:flex-row">
        <Input
          value={path}
          onChange={(e) => setPath(e.target.value)}
          placeholder={m['creating_pages.new_path_placeholder']()}
          aria-label={m['creating_pages.new_page_button']()}
          className="font-mono"
          autoFocus
          disabled={createDraft.isPending}
        />
        <Button type="submit" disabled={createDraft.isPending} className="shrink-0">
          {createDraft.isPending ? <Loader2 className="mr-1 h-4 w-4 animate-spin" /> : <Plus className="mr-1 h-4 w-4" />}
          {createDraft.isPending ? m['creating_pages.new_submit_pending']() : m['creating_pages.new_submit']()}
        </Button>
      </form>

      {error?.kind === 'conflict' && <DraftConflictAlert displayName={error.displayName} username={error.username} />}
      {error?.kind === 'message' && <ErrorAlert message={error.text} />}
    </div>
  );
}

interface DraftsSectionProps {
  drafts: DraftSummary[];
  isLoading: boolean;
  isError: boolean;
}

function DraftsSection({ drafts, isLoading, isError }: DraftsSectionProps) {
  if (isLoading) {
    return <DraftsSkeleton />;
  }
  if (isError) {
    return <ErrorAlert message={m['creating_pages.failed_to_load']()} />;
  }
  if (drafts.length === 0) {
    return (
      <div className="rounded-lg border border-dashed py-10 text-center">
        <p className="text-sm text-muted-foreground">{m['creating_pages.empty']()}</p>
      </div>
    );
  }
  return (
    <Card className="gap-0 overflow-hidden p-0 py-0">
      <ul className="divide-y">
        {drafts.map((draft) => (
          <DraftRow key={draft.pageId} draft={draft} />
        ))}
      </ul>
    </Card>
  );
}

function DraftsSkeleton() {
  // Mirrors the real DraftRow geometry so the layout doesn't jump when
  // data lands:
  //   • outer is `flex items-center gap-3` to leave room for the right-
  //     hand action column,
  //   • inner content uses `space-y-0.5` (same as DraftRow) with h-4 for
  //     the path line and h-3 for the timestamps line,
  //   • the right column holds two icon-button placeholders sized to
  //     the Pencil / Trash ghost buttons.
  return (
    <div role="status" aria-live="polite" aria-label={m['creating_pages.loading']()}>
      <Card className="gap-0 overflow-hidden p-0 py-0" aria-hidden>
        <ul className="divide-y">
          {Array.from({ length: 3 }, (_, i) => `draft-skeleton-${i}`).map((key) => (
            <li key={key} className="flex items-center gap-3 px-4 py-3">
              <div className="min-w-0 flex-1 space-y-0.5">
                <div className="h-4 w-1/2 animate-pulse rounded bg-muted" />
                <div className="h-3 w-1/3 animate-pulse rounded bg-muted" />
              </div>
              <div className="flex shrink-0 items-center gap-1">
                <div className="h-7 w-7 animate-pulse rounded-md bg-muted" />
                <div className="h-7 w-7 animate-pulse rounded-md bg-muted" />
              </div>
            </li>
          ))}
        </ul>
      </Card>
    </div>
  );
}

/**
 * `updatedAt === createdAt` for a draft that was created but never
 * subsequently touched. Surfacing "edited 0 seconds after start" would
 * be noise — only show the second timestamp when the page has had
 * meaningful activity (treat anything within 1 minute as "no real edit
 * yet"). `Page.updatedAt` is bumped by the collab compaction store,
 * so it does reflect Yjs editing — unlike the revision body.
 */
function hasMeaningfulEdit(createdAt: string, updatedAt: string): boolean {
  const created = Date.parse(createdAt);
  const updated = Date.parse(updatedAt);
  if (Number.isNaN(created) || Number.isNaN(updated)) return false;
  return updated - created >= 60_000;
}

function DraftRow({ draft }: { draft: DraftSummary }) {
  const router = useRouter();
  const cancelDraft = useCancelDraft();
  const [confirmOpen, setConfirmOpen] = useState(false);

  const editHref = draftEditHref(draft.pageId);
  const showUpdated = hasMeaningfulEdit(draft.createdAt, draft.updatedAt);

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
    <li className="group px-4 py-3 transition-colors hover:bg-accent/50">
      <div className="flex items-center gap-3">
        <div className="min-w-0 flex-1 space-y-0.5">
          {/* Line 1 — path (links to the editor) */}
          <Link
            href={editHref}
            className="block truncate font-mono text-sm font-medium text-foreground transition-colors hover:text-primary"
            title={draft.path}
          >
            {draft.path}
          </Link>

          {/* Line 2 — start / last-edit timestamps */}
          <p className="text-xs text-muted-foreground">
            {m['creating_pages.started_at']({ when: formatDistanceToNow(draft.createdAt) })}
            {showUpdated && (
              <>
                <span aria-hidden className="mx-2 text-border">
                  ·
                </span>
                {m['creating_pages.updated_at']({ when: formatDistanceToNow(draft.updatedAt) })}
              </>
            )}
          </p>
        </div>

        {/* Icon action column — Edit / Cancel. Icon-only keeps the row
            tight; aria-label + title carry the accessible label. */}
        <div className="flex shrink-0 items-center gap-1">
          <Button
            variant="ghost"
            size="icon-sm"
            onClick={() => router.push(editHref)}
            aria-label={m['creating_pages.action_edit']()}
            title={m['creating_pages.action_edit']()}
          >
            <Pencil className="h-4 w-4" />
          </Button>
          <Button
            variant="ghost"
            size="icon-sm"
            onClick={() => setConfirmOpen(true)}
            aria-label={m['creating_pages.action_cancel']()}
            title={m['creating_pages.action_cancel']()}
            className="text-muted-foreground hover:text-destructive"
          >
            <Trash2 className="h-4 w-4" />
          </Button>
        </div>
      </div>

      {/* Controlled (no Trigger child): we close explicitly in the
          mutation callbacks so the dialog stays open while the DELETE
          is in flight. */}
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
    </li>
  );
}
