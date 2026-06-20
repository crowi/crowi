'use client';

import type { PageWithRevision } from '@crowi/api-contract';
import { m } from '@paraglide/messages.js';
import { AlertCircle, ArrowRight, Compass, Loader2 } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { pagePathToHref } from '@/lib/page-path';
import { PageRevisionConflictError, useRenamePage } from '@/lib/use-page-mutations';

/**
 * "Portalize" confirmation dialog (feature-update-pages-list-ux §3 / §4).
 *
 * Turns a content page `/some-page` into the portal `/some-page/` by moving
 * it (a single-page rename, descendants untouched — they already sit under
 * `/some-page/...`). The move leaves NO redirect at the old path (portal
 * destinations never get a redirect — `create_redirect` is omitted, and the
 * server skips redirects for `/`-suffixed targets), which together with the
 * server-side twin guard (§6) prevents the `/x` ↔ `/x/` double-state from
 * coming back.
 *
 * Shared by two entry points, both passing the content page as `page`:
 *   - the page dot-menu "Portalize" item (`PageActionsMenu`)
 *   - the `/some-page/` list-view portalize banner (`PageList`)
 *
 * On success it navigates to the new portal path; the rename mutation's
 * `onSuccess` invalidates the page / list caches so the destination re-fetches
 * with the page now living as the portal document.
 */
export function PortalizeDialog({ page, open, onOpenChange }: { page: PageWithRevision; open: boolean; onOpenChange: (open: boolean) => void }) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>{open && <PortalizeDialogBody page={page} onOpenChange={onOpenChange} />}</DialogContent>
    </Dialog>
  );
}

function PortalizeDialogBody({ page, onOpenChange }: { page: PageWithRevision; onOpenChange: (open: boolean) => void }) {
  const router = useRouter();
  const renameMutation = useRenamePage();
  const [error, setError] = useState<string | null>(null);

  // The source is always a content path (the menu / banner only offer this
  // for `!page.path.endsWith('/')`); the portal is the same path with a
  // trailing slash.
  const fromPath = page.path;
  const toPath = `${page.path}/`;
  const isSubmitting = renameMutation.isPending;

  const handlePortalize = async () => {
    setError(null);
    try {
      const result = await renameMutation.mutateAsync({
        page_id: page._id,
        new_path: toPath,
        revision_id: page.revision?._id,
        // No redirect: portalizing must not leave a `/some-page` stub
        // behind (§5). The server also skips redirects for portal targets.
        include_descendants: false,
      });
      onOpenChange(false);
      router.push(pagePathToHref(result.page.path));
    } catch (err) {
      if (err instanceof PageRevisionConflictError) {
        setError(err.message);
        return;
      }
      setError(err instanceof Error ? err.message : m['page.portalize.failed']());
    }
  };

  return (
    <>
      <DialogHeader>
        <DialogTitle className="flex items-center gap-2">
          <Compass className="h-5 w-5 text-primary" />
          {m['page.portalize.title']()}
        </DialogTitle>
        <DialogDescription>{m['page.portalize.description']()}</DialogDescription>
      </DialogHeader>

      {error && (
        <Alert variant="destructive">
          <AlertCircle className="h-4 w-4" />
          <AlertTitle>{m['page.portalize.error_title']()}</AlertTitle>
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}

      <div className="flex flex-wrap items-center gap-2 rounded-lg border bg-muted/30 p-3 font-mono text-sm">
        <span className="min-w-0 truncate">{fromPath}</span>
        <ArrowRight className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
        <span className="min-w-0 truncate font-medium text-foreground">{toPath}</span>
      </div>

      <p className="text-xs text-muted-foreground">{m['page.portalize.no_redirect_note']()}</p>

      <DialogFooter>
        <DialogClose asChild>
          <Button type="button" variant="outline" disabled={isSubmitting}>
            {m['page.portalize.cancel']()}
          </Button>
        </DialogClose>
        <Button type="button" onClick={handlePortalize} disabled={isSubmitting}>
          {isSubmitting && <Loader2 className="mr-1 h-4 w-4 animate-spin" />}
          {m['page.portalize.submit']()}
        </Button>
      </DialogFooter>
    </>
  );
}
