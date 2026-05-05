'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Loader2, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { useDeletePage } from '@/lib/use-page-mutations';

interface DeletePageButtonProps {
  pageId: string;
  pagePath: string;
  revisionId?: string;
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

export function DeletePageButton({ pageId, pagePath, revisionId }: DeletePageButtonProps) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [completely, setCompletely] = useState(false);
  const { mutate, isPending, isError, error, reset } = useDeletePage();

  const handleConfirm = () => {
    mutate(
      { page_id: pageId, revision_id: revisionId, completely: completely || undefined },
      {
        onSuccess: () => {
          setOpen(false);
          // Soft delete: navigate to parent path (legacy behavior).
          // Hard delete: same — the page no longer exists, so parent is the safest target.
          router.replace(parentPathOf(pagePath));
        },
      },
    );
  };

  const handleOpenChange = (next: boolean) => {
    setOpen(next);
    if (!next) {
      // Reset transient state when the dialog closes so reopening starts clean.
      setCompletely(false);
      reset();
    }
  };

  return (
    <>
      <Button variant="outline" size="sm" onClick={() => setOpen(true)} aria-label="Delete page">
        <Trash2 className="h-4 w-4 mr-1" />
        Delete
      </Button>

      <Dialog open={open} onOpenChange={handleOpenChange}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>このページを削除しますか?</DialogTitle>
            <DialogDescription>
              {completely ? `「${pagePath}」を完全に削除します。この操作は取り消せません。` : `「${pagePath}」をゴミ箱に移動します。あとで復元できます。`}
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
              完全に削除する (ゴミ箱に残さない)
            </label>
          </div>

          {isError && error instanceof Error && (
            <p className="text-sm text-destructive" role="alert">
              {error.message}
            </p>
          )}

          <DialogFooter>
            <Button variant="outline" onClick={() => handleOpenChange(false)} disabled={isPending}>
              キャンセル
            </Button>
            <Button variant="destructive" onClick={handleConfirm} disabled={isPending}>
              {isPending ? (
                <>
                  <Loader2 className="h-4 w-4 mr-1 animate-spin" />
                  削除中...
                </>
              ) : completely ? (
                '完全に削除'
              ) : (
                'ゴミ箱に移動'
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
