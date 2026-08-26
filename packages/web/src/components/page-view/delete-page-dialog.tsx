'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { useDeletePage } from '@/lib/use-page-mutations';
import { pagePathToHref } from '@/lib/page-path';
import { m } from '@paraglide/messages.js';

interface DeletePageDialogProps {
  pageId: string;
  pagePath: string;
  revisionId?: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

/**
 * Compute the navigation target after a soft delete: the parent path of the
 * deleted page. Mirrors the legacy React UI which fell back to the parent
 * directory after deletion. Defensive against `/` (root is non-deletable but
 * we still avoid an empty string return).
 */
function parentPathOf(path: string): string {
  if (path === '/' || path === '') return '/';
  const trimmed = path.endsWith('/') ? path.slice(0, -1) : path;
  const lastSlash = trimmed.lastIndexOf('/');
  if (lastSlash <= 0) return '/';
  return trimmed.slice(0, lastSlash);
}

export function DeletePageDialog({ pageId, pagePath, revisionId, open, onOpenChange }: DeletePageDialogProps) {
  const router = useRouter();
  const [completely, setCompletely] = useState(false);
  const { mutate, isPending, isError, error, reset } = useDeletePage();

  const handleConfirm = () => {
    mutate(
      // One key per confirmation — a repeat click is a fresh attempt, not a
      // replay of the one that failed.
      { page_id: pageId, revision_id: revisionId, completely: completely || undefined, idempotencyKey: crypto.randomUUID().replaceAll('-', '') },
      {
        onSuccess: () => {
          onOpenChange(false);
          // Soft delete: navigate to parent path (legacy behavior).
          // Hard delete: same — the page no longer exists, so parent is the safest target.
          router.replace(pagePathToHref(parentPathOf(pagePath)));
        },
      },
    );
  };

  const handleOpenChange = (next: boolean) => {
    onOpenChange(next);
    if (!next) {
      // Reset transient state when the dialog closes so reopening starts clean.
      setCompletely(false);
      reset();
    }
  };

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{m['page.delete.title']()}</DialogTitle>
          <DialogDescription>
            {completely ? m['page.delete.description_hard']({ path: pagePath }) : m['page.delete.description_soft']({ path: pagePath })}
          </DialogDescription>
        </DialogHeader>

        <div className="flex items-center gap-2 py-2">
          <input
            id="delete-page-completely"
            type="checkbox"
            checked={completely}
            onChange={(e) => setCompletely(e.target.checked)}
            disabled={isPending}
            className="h-4 w-4 rounded border-input"
          />
          <label htmlFor="delete-page-completely" className="text-sm">
            {m['page.delete.completely_label']()}
          </label>
        </div>

        {isError && error instanceof Error && (
          <p className="text-sm text-destructive" role="alert">
            {error.message}
          </p>
        )}

        <DialogFooter>
          <Button variant="outline" onClick={() => handleOpenChange(false)} disabled={isPending}>
            {m['page.delete.cancel']()}
          </Button>
          <Button variant="destructive" onClick={handleConfirm} disabled={isPending}>
            {isPending ? (
              <>
                <Loader2 className="h-4 w-4 mr-1 animate-spin" />
                {m['page.delete.submit_pending']()}
              </>
            ) : completely ? (
              m['page.delete.submit_hard']()
            ) : (
              m['page.delete.submit_soft']()
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
