'use client';

import type { PageWithRevision } from '@crowi/api-contract';
import { m } from '@paraglide/messages.js';
import { AlertCircle, ArrowRight, Loader2 } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useMemo, useState } from 'react';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { notify } from '@/lib/notify';
import { usePageList } from '@/lib/use-page-list';
import { pagePathToHref } from '@/lib/page-path';
import { PageRevisionConflictError, type RenameTreeConflict, RenameTreeConflictError, useRenamePage } from '@/lib/use-page-mutations';

interface RenameDialogProps {
  page: PageWithRevision;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

type Feedback = { kind: 'conflict' | 'error'; message: string } | { kind: 'tree_conflict'; message: string; conflicts: RenameTreeConflict[]; partial: boolean };

const DESCENDANT_PREVIEW_LIMIT = 5;

type PathValidation = { ok: true } | { ok: false; reason: 'invalid_path' | 'root_target' };

function validateNewPath(path: string): PathValidation {
  if (!path || !path.startsWith('/')) return { ok: false, reason: 'invalid_path' };
  // A new path that normalises to just '/' is meaningless (cannot rename to
  // the root portal). Reject before submit and before the preview rewrites
  // descendant paths with an empty base.
  if (path.replace(/\/+$/, '') === '') return { ok: false, reason: 'root_target' };
  return { ok: true };
}

/**
 * Outer wrapper: keeps the dialog mounted at all times but unmounts the form
 * when closed. This guarantees that internal form state is fresh on every open
 * (so we don't need a useEffect to reset it).
 */
export function RenameDialog({ page, open, onOpenChange }: RenameDialogProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>{open && <RenameDialogForm page={page} onOpenChange={onOpenChange} />}</DialogContent>
    </Dialog>
  );
}

interface RenameDialogFormProps {
  page: PageWithRevision;
  onOpenChange: (open: boolean) => void;
}

function RenameDialogForm({ page, onOpenChange }: RenameDialogFormProps) {
  const router = useRouter();
  const renameMutation = useRenamePage();

  const [newPath, setNewPath] = useState(page.path);
  const [feedback, setFeedback] = useState<Feedback | null>(null);
  const [includeDescendants, setIncludeDescendants] = useState(false);

  const isSubmitting = renameMutation.isPending;
  const isUnchanged = newPath === page.path;
  const validation = validateNewPath(newPath);
  const isInvalid = !validation.ok;
  const invalidMessage = !validation.ok
    ? validation.reason === 'root_target'
      ? m['page.rename.invalid_root_target']()
      : m['page.rename.invalid_path']()
    : null;

  // Descendants of this page — the subtree a `renameTree` would move along
  // with it. Fetched only while the dialog is open (this form is unmounted
  // when closed). Used to surface the subtree-move affordance.
  //
  // Renaming the root portal '/' is not a meaningful operation and the
  // listing endpoint's path='/' branch would return a slice of unrelated
  // site-wide pages — short-circuit by disabling the query.
  const isRoot = page.path === '/';
  const descendantRoot = page.path.endsWith('/') ? page.path : `${page.path}/`;
  const { data: descendantData } = usePageList({ path: descendantRoot, limit: 100, offset: 0, include_deleted: false }, { enabled: !isRoot });
  // When a portal page '/foo/bar/' is being renamed, findListByStartWith
  // also returns the un-slashed leaf '/foo/bar' (see Page.findListByStartWith
  // — it appends `path.substr(0, path.length-1)` to the path conditions).
  // That leaf is a separate page, not a descendant of the portal, so drop
  // both the page itself and its un-slashed twin.
  const pageSelfPaths = useMemo(() => {
    const stripped = page.path.replace(/\/+$/, '');
    return new Set([page.path, stripped]);
  }, [page.path]);
  const descendants = useMemo(() => (descendantData?.pages ?? []).filter((p) => !pageSelfPaths.has(p.path)), [descendantData, pageSelfPaths]);
  const descendantCount = descendants.length;
  // `descendantData.pager.next` is non-null when there are more pages of
  // descendants beyond the limit=100 fetch — we surface that as a "X+"
  // marker so the count never silently understates a large subtree.
  const isCountTruncated = descendantData?.pager?.next != null;

  // Preview of how subtree paths would be rewritten under the new path.
  const preview = useMemo(() => {
    const oldBase = page.path.replace(/\/+$/, '');
    const newBase = newPath.replace(/\/+$/, '');
    return descendants.slice(0, DESCENDANT_PREVIEW_LIMIT).map((d) => ({
      from: d.path,
      to: `${newBase}${d.path.slice(oldBase.length)}`,
    }));
  }, [descendants, page.path, newPath]);
  const moreCount = descendantCount - preview.length;

  const canSubmit = !isSubmitting && !isUnchanged && !isInvalid;

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!canSubmit) return;

    setFeedback(null);

    try {
      const result = await renameMutation.mutateAsync({
        page_id: page._id,
        new_path: newPath,
        revision_id: page.revision._id,
        // Match legacy behaviour: always create a redirect page from the old path.
        create_redirect: true,
        include_descendants: includeDescendants,
      });

      onOpenChange(false);
      // Surface the moved count for a subtree move so the user sees the
      // bulk effect; a single rename navigates silently as before.
      if (includeDescendants) {
        notify.info(m['page.rename.success_tree']({ count: result.renamedCount }));
      }
      router.replace(pagePathToHref(result.page.path));
    } catch (err) {
      if (err instanceof PageRevisionConflictError) {
        setFeedback({ kind: 'conflict', message: err.message });
        return;
      }
      if (err instanceof RenameTreeConflictError) {
        setFeedback({ kind: 'tree_conflict', message: err.message, conflicts: err.conflicts, partial: err.partial });
        return;
      }
      setFeedback({
        kind: 'error',
        message: err instanceof Error ? err.message : m['page.rename.failed'](),
      });
    }
  };

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      <DialogHeader>
        <DialogTitle>{m['page.rename.title']()}</DialogTitle>
        <DialogDescription>{m['page.rename.description']()}</DialogDescription>
      </DialogHeader>

      {feedback && feedback.kind !== 'tree_conflict' && (
        <Alert variant="destructive">
          <AlertCircle className="h-4 w-4" />
          <AlertTitle>{feedback.kind === 'conflict' ? m['page.rename.conflict_title']() : m['page.rename.error_title']()}</AlertTitle>
          <AlertDescription>{feedback.message}</AlertDescription>
        </Alert>
      )}

      {feedback && feedback.kind === 'tree_conflict' && (
        <Alert variant="destructive">
          <AlertCircle className="h-4 w-4" />
          <AlertTitle>{m['page.rename.conflict_tree_title']()}</AlertTitle>
          <AlertDescription className="space-y-2">
            <p>{feedback.partial ? m['page.rename.conflict_tree_partial']() : m['page.rename.conflict_tree_description']()}</p>
            {feedback.conflicts.length > 0 && (
              <ul className="space-y-0.5 font-mono text-xs">
                {feedback.conflicts.map((conflict) => (
                  <li key={conflict.path} className="truncate">
                    {conflict.path}
                  </li>
                ))}
              </ul>
            )}
          </AlertDescription>
        </Alert>
      )}

      <div className="space-y-2">
        <Label htmlFor="rename-current-path">{m['page.rename.current_path']()}</Label>
        <Input id="rename-current-path" value={page.path} readOnly className="font-mono text-sm bg-muted" />
      </div>

      <div className="space-y-2">
        <Label htmlFor="rename-new-path">{m['page.rename.new_path']()}</Label>
        <Input
          id="rename-new-path"
          value={newPath}
          onChange={(event) => setNewPath(event.target.value)}
          disabled={isSubmitting}
          placeholder={m['page.rename.placeholder']()}
          className="font-mono text-sm"
          autoFocus
          aria-invalid={isInvalid && newPath.length > 0 ? true : undefined}
        />
        {isInvalid && invalidMessage && newPath.length > 0 && <p className="text-xs text-destructive">{invalidMessage}</p>}
      </div>

      {/* Subtree-move (renameTree) affordance — only when the page has
          descendants. Toggling it on moves the page together with its
          whole grant-visible subtree. */}
      {descendantCount > 0 && (
        <div className="space-y-3 rounded-lg border bg-muted/30 p-3">
          <div className="flex items-start justify-between gap-3">
            <div className="space-y-0.5">
              <Label htmlFor="rename-include-descendants" className="text-sm font-medium">
                {m['page.rename.include_descendants']()}
              </Label>
              <p className="text-xs text-muted-foreground">
                {isCountTruncated
                  ? m['page.rename.descendants_count_more']({ count: descendantCount })
                  : m['page.rename.descendants_count']({ count: descendantCount })}
              </p>
            </div>
            <Switch
              id="rename-include-descendants"
              checked={includeDescendants}
              onCheckedChange={setIncludeDescendants}
              disabled={isSubmitting}
              aria-label={m['page.rename.include_descendants']()}
            />
          </div>

          {includeDescendants && (
            <>
              <p className="text-xs text-muted-foreground">{m['page.rename.descendants_note']()}</p>

              {preview.length > 0 && !isInvalid && (
                <div className="space-y-1.5">
                  <p className="text-xs font-medium text-muted-foreground">{m['page.rename.descendants_preview_title']()}</p>
                  <ul className="space-y-1">
                    {preview.map((item) => (
                      <li key={item.from} className="flex items-center gap-1.5 font-mono text-xs">
                        <span className="truncate text-muted-foreground line-through">{item.from}</span>
                        <ArrowRight className="h-3 w-3 shrink-0 text-muted-foreground" />
                        <span className="truncate text-foreground">{item.to}</span>
                      </li>
                    ))}
                  </ul>
                  {moreCount > 0 && <p className="text-xs text-muted-foreground">{m['page.rename.descendants_more']({ count: moreCount })}</p>}
                </div>
              )}
            </>
          )}
        </div>
      )}

      <DialogFooter>
        <DialogClose asChild>
          <Button type="button" variant="outline" disabled={isSubmitting}>
            {m['page.rename.cancel']()}
          </Button>
        </DialogClose>
        <Button type="submit" disabled={!canSubmit}>
          {isSubmitting && <Loader2 className="h-4 w-4 mr-1 animate-spin" />}
          {m['page.rename.submit']()}
        </Button>
      </DialogFooter>
    </form>
  );
}
