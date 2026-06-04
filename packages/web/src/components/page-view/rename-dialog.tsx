'use client';

import type { PageWithRevision } from '@crowi/api-contract';
import { m } from '@paraglide/messages.js';
import { AlertCircle, ArrowRight, ExternalLink, Loader2 } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useMemo, useState } from 'react';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { notify } from '@/lib/notify';
import { pagePathToHref } from '@/lib/page-path';
import { usePageList } from '@/lib/use-page-list';
import { PageRevisionConflictError, type RenameTreeConflict, RenameTreeConflictError, useRenamePage, useRenameSubtree } from '@/lib/use-page-mutations';
import { cn } from '@/lib/utils';

/**
 * Two modes:
 *   - `page`: rename a real page (optionally with its subtree).
 *   - `folderPath`: rename a portal-less folder (a list path with descendants
 *     but no page document of its own) — always a subtree move by path, since
 *     there is no page_id/revision to key on.
 */
type RenameDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
} & ({ page: PageWithRevision; folderPath?: never } | { folderPath: string; page?: never });

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
export function RenameDialog(props: RenameDialogProps) {
  const { open, onOpenChange } = props;
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      {/* Wider than the default dialog so long subtree-move paths fit. */}
      <DialogContent className="sm:max-w-2xl">
        {open &&
          (props.page ? (
            <RenameDialogForm basePath={props.page.path} pageId={props.page._id} revisionId={props.page.revision?._id} onOpenChange={onOpenChange} />
          ) : (
            <RenameDialogForm basePath={props.folderPath} isFolder onOpenChange={onOpenChange} />
          ))}
      </DialogContent>
    </Dialog>
  );
}

interface RenameDialogFormProps {
  /** The page's path, or the folder path being renamed. */
  basePath: string;
  /** Set in page mode — the page being renamed. */
  pageId?: string;
  /** Set in page mode — for optimistic-lock on the root revision. */
  revisionId?: string;
  /** True when renaming a portal-less folder (always a subtree move by path). */
  isFolder?: boolean;
  onOpenChange: (open: boolean) => void;
}

function RenameDialogForm({ basePath, pageId, revisionId, isFolder = false, onOpenChange }: RenameDialogFormProps) {
  const router = useRouter();
  const renameMutation = useRenamePage();
  const renameSubtreeMutation = useRenameSubtree();

  const [newPath, setNewPath] = useState(basePath);
  const [feedback, setFeedback] = useState<Feedback | null>(null);
  // Folder mode is always a subtree move; page mode is opt-in via the switch.
  const [includeDescendantsState, setIncludeDescendants] = useState(false);
  const includeDescendants = isFolder || includeDescendantsState;

  const isSubmitting = renameMutation.isPending || renameSubtreeMutation.isPending;
  const isUnchanged = newPath === basePath;
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
  const isRoot = basePath === '/';
  const descendantRoot = basePath.endsWith('/') ? basePath : `${basePath}/`;
  // `limit: 0` fetches the whole subtree (Mongoose treats `.limit(0)` as no
  // limit) so the count is exact and the user can expand to verify every page
  // that would move — the server-side renameTree scans the same full subtree.
  const { data: descendantData } = usePageList({ path: descendantRoot, limit: 0, offset: 0, include_deleted: false }, { enabled: !isRoot });
  // When a portal page '/foo/bar/' is being renamed, findListByStartWith
  // also returns the un-slashed leaf '/foo/bar' (see Page.findListByStartWith
  // — it appends `path.substr(0, path.length-1)` to the path conditions).
  // That leaf is a separate page, not a descendant of the portal, so drop
  // both the page itself and its un-slashed twin.
  const pageSelfPaths = useMemo(() => {
    const stripped = basePath.replace(/\/+$/, '');
    return new Set([basePath, stripped]);
  }, [basePath]);
  const descendants = useMemo(() => (descendantData?.pages ?? []).filter((p) => !pageSelfPaths.has(p.path)), [descendantData, pageSelfPaths]);
  const descendantCount = descendants.length;

  // The full list of how every subtree path would be rewritten under the new
  // path. Collapsed to the first DESCENDANT_PREVIEW_LIMIT rows by default; the
  // "+N more" toggle reveals the rest in a scrollable list.
  const [showAllDescendants, setShowAllDescendants] = useState(false);
  const rewrites = useMemo(() => {
    const oldBase = basePath.replace(/\/+$/, '');
    const newBase = newPath.replace(/\/+$/, '');
    return descendants.map((d) => ({
      from: d.path,
      to: `${newBase}${d.path.slice(oldBase.length)}`,
    }));
  }, [descendants, basePath, newPath]);
  const preview = showAllDescendants ? rewrites : rewrites.slice(0, DESCENDANT_PREVIEW_LIMIT);
  const moreCount = rewrites.length - DESCENDANT_PREVIEW_LIMIT;
  // How many pages a subtree move will touch — descendants in folder mode, or
  // the root + descendants in page mode. Surfaced in the submit button while
  // the (potentially slow) move runs.
  const moveCount = isFolder ? descendantCount : descendantCount + 1;

  // A folder move needs at least one visible page under it — the folder path
  // itself has no page, so an empty subtree means there is nothing to move.
  const canSubmit = !isSubmitting && !isUnchanged && !isInvalid && (!isFolder || descendantCount > 0);

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!canSubmit) return;

    setFeedback(null);

    try {
      if (isFolder) {
        const count = await renameSubtreeMutation.mutateAsync({
          old_path: basePath,
          new_path: newPath,
          create_redirect: true,
        });
        onOpenChange(false);
        notify.info(m['page.rename.success_tree']({ count }));
        // The folder has no page of its own — navigate to the new folder's
        // list view (newPath is a folder path).
        router.replace(pagePathToHref(newPath));
        return;
      }

      const result = await renameMutation.mutateAsync({
        page_id: pageId as string,
        new_path: newPath,
        revision_id: revisionId,
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

  // The from→to preview list, shared by the page (switch-on) and folder modes.
  const previewBlock =
    preview.length > 0 && !isInvalid ? (
      <div className="space-y-1.5">
        <p className="text-xs font-medium text-muted-foreground">{m['page.rename.descendants_preview_title']()}</p>
        <ul className={cn('space-y-1.5', showAllDescendants && 'max-h-56 overflow-y-auto pr-1')}>
          {preview.map((item) => (
            <li key={item.from} className="min-w-0 font-mono text-xs">
              {/* The page still lives at its old path until the move runs, so
                  link `from` (not `to`) and open it in a new tab for inspection
                  without leaving the dialog. */}
              <a
                href={pagePathToHref(item.from)}
                target="_blank"
                rel="noopener noreferrer"
                title={m['page.rename.descendants_open_aria']({ path: item.from })}
                className="flex items-center gap-1 text-muted-foreground hover:text-foreground"
              >
                <span className="min-w-0 truncate line-through">{item.from}</span>
                <ExternalLink className="h-3 w-3 shrink-0" aria-hidden />
              </a>
              <span className="flex items-center gap-1.5 text-foreground">
                <ArrowRight className="h-3 w-3 shrink-0 text-muted-foreground" />
                <span className="min-w-0 truncate">{item.to}</span>
              </span>
            </li>
          ))}
        </ul>
        {moreCount > 0 && (
          <button
            type="button"
            onClick={() => setShowAllDescendants((v) => !v)}
            className="text-xs text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
          >
            {showAllDescendants ? m['page.rename.descendants_collapse']() : m['page.rename.descendants_more']({ count: moreCount })}
          </button>
        )}
      </div>
    ) : null;

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      <DialogHeader>
        <DialogTitle>{isFolder ? m['page.rename.folder_title']() : m['page.rename.title']()}</DialogTitle>
        <DialogDescription>{isFolder ? m['page.rename.folder_description']() : m['page.rename.description']()}</DialogDescription>
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
        <Input id="rename-current-path" value={basePath} readOnly className="font-mono text-sm bg-muted" />
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

      {/* Folder mode: always a subtree move (the folder has no page of its
          own), so there is no toggle — just the count + preview. */}
      {isFolder && (
        <div className="space-y-3 rounded-lg border bg-muted/30 p-3">
          <p className="text-xs text-muted-foreground">
            {descendantCount > 0 ? m['page.rename.folder_note']({ count: descendantCount }) : m['page.rename.folder_empty']()}
          </p>
          {previewBlock}
        </div>
      )}

      {/* Page mode: optional subtree move via a switch — only when the page
          has descendants. Toggling it on moves the page together with its
          whole grant-visible subtree. */}
      {!isFolder && descendantCount > 0 && (
        <div className="space-y-3 rounded-lg border bg-muted/30 p-3">
          <div className="flex items-start justify-between gap-3">
            <div className="space-y-0.5">
              <Label htmlFor="rename-include-descendants" className="text-sm font-medium">
                {m['page.rename.include_descendants']()}
              </Label>
              <p className="text-xs text-muted-foreground">{m['page.rename.descendants_count']({ count: descendantCount })}</p>
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
              {previewBlock}
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
          {isSubmitting && includeDescendants ? m['page.rename.submitting_tree']({ count: moveCount }) : m['page.rename.submit']()}
        </Button>
      </DialogFooter>
    </form>
  );
}
