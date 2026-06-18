'use client';

import { m } from '@paraglide/messages.js';
import { AlertTriangle, Loader2, Undo2 } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { useRevertToRevision } from '@/lib/use-page-mutations';
import { notify } from '@/lib/notify';

interface StaleRevisionBannerProps {
  /** The page's current (latest) path — also the "show latest" link target. */
  pagePath: string;
  /** The page document id, for the revert mutation. */
  pageId: string;
  /** The past revision currently being viewed, i.e. the one to revert TO. */
  revisionId: string;
}

export function StaleRevisionBanner({ pagePath, pageId, revisionId }: StaleRevisionBannerProps) {
  const router = useRouter();
  const revertMutation = useRevertToRevision();

  // One-click, no confirmation dialog: revert is non-destructive (the old
  // body is stacked as a new revision, history is preserved), so a confirm
  // step would only add friction. On success, navigate to the latest page
  // (the revision_id-less URL) so the user lands on the freshly-reverted
  // current version.
  const handleRevert = () => {
    revertMutation.mutate(
      { page_id: pageId, revision_id: revisionId },
      {
        onSuccess: () => {
          notify.info(m['page.revert_success']());
          router.push(pagePath);
        },
        onError: (error) => {
          notify.error(error instanceof Error ? error.message : m['errors.revert_failed']());
        },
      },
    );
  };

  return (
    <Alert className="border-amber-300 bg-amber-50 text-amber-900 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-200">
      <AlertTriangle className="h-4 w-4" />
      <AlertDescription className="flex flex-wrap items-center gap-3">
        <span className="font-medium">{m['page.stale_revision_warning']()}</span>
        <Link href={pagePath} className="underline underline-offset-2 hover:no-underline">
          {m['page.stale_revision_show_latest']()}
        </Link>
        <Button
          variant="outline"
          size="sm"
          className="border-amber-300 text-amber-900 hover:bg-amber-100 dark:border-amber-700 dark:text-amber-200 dark:hover:bg-amber-900/40"
          onClick={handleRevert}
          disabled={revertMutation.isPending}
        >
          {revertMutation.isPending ? (
            <>
              <Loader2 className="h-4 w-4 mr-1 animate-spin" />
              {m['page.reverting']()}
            </>
          ) : (
            <>
              <Undo2 className="h-4 w-4 mr-1" />
              {m['page.revert_to_this_version']()}
            </>
          )}
        </Button>
      </AlertDescription>
    </Alert>
  );
}
