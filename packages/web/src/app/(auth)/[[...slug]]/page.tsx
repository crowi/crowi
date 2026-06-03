'use client';

import { usePathname, useSearchParams } from 'next/navigation';
import { IdRedirector } from '@/components/id-redirector';
import { PageList } from '@/components/page-list/page-list';
import { PageView } from '@/components/page-view';
import { UserDirectoryPreview } from '@/components/user-directory/user-directory-preview';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { isObjectId } from '@/lib/object-id';
import { decodePagePathFromUrl, pageDisplayName } from '@/lib/page-path';
import { usePageTitle } from '@/lib/use-page-title';

export default function CatchAllPage() {
  const pathname = usePathname();
  const searchParams = useSearchParams();

  const redirectFrom = searchParams.get('redirectFrom');
  const revisionId = searchParams.get('revision_id') || undefined;

  // Next.js usePathname() returns URL-encoded paths (e.g., /%E3%83%A6%E3%83%BC%E3%82%B6%E3%83%BC).
  // Decode so the value matches what the API expects — and follow legacy
  // Crowi by reading `+` as a space (the readable URL form of a space in
  // a page path; see decodePagePathFromUrl).
  const path = pathname === '/' ? '/' : decodePagePathFromUrl(pathname);
  const isPortalPath = path.endsWith('/');
  // `/user/` is the member directory: a portal-style list page that leads
  // with the user roster and forbids creating a portal document of its own.
  const isUserDirectory = path === '/user/';
  const segments = path.split('/').filter(Boolean);

  // Only the last path segment names the tab (e.g.
  // /crowi/rfc/0001-plugin-architecture → "0001-plugin-architecture");
  // the top page has no segment.
  usePageTitle(pageDisplayName(path) || null);

  // Single-segment 24-char hex ObjectId → resolve to the page's actual path.
  if (segments.length === 1 && isObjectId(segments[0])) {
    return <IdRedirector pageId={segments[0]} />;
  }

  return (
    <>
      {redirectFrom && (
        <Alert className="mb-6">
          <AlertDescription>
            Redirected from <code className="bg-muted px-2 py-0.5 rounded">{redirectFrom}</code>
          </AlertDescription>
        </Alert>
      )}

      {isUserDirectory ? (
        <div className="space-y-8">
          <UserDirectoryPreview />
          <PageList initialParams={{ path }} disableCreatePortal />
        </div>
      ) : isPortalPath ? (
        <PageList initialParams={{ path }} />
      ) : (
        <PageView path={path} revisionId={revisionId} />
      )}
    </>
  );
}
