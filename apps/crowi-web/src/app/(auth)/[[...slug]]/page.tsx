'use client';

import { usePathname, useSearchParams } from 'next/navigation';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { IdRedirector } from '@/components/id-redirector';
import { PageList } from '@/components/page-list/page-list';
import { PageView } from '@/components/page-view';
import { isObjectId } from '@/lib/object-id';

export default function CatchAllPage() {
  const pathname = usePathname();
  const searchParams = useSearchParams();

  const redirectFrom = searchParams.get('redirectFrom');
  const revisionId = searchParams.get('revision_id') || undefined;

  // Next.js usePathname() returns URL-encoded paths (e.g., /%E3%83%A6%E3%83%BC%E3%82%B6%E3%83%BC).
  // Decode so the value matches what the API expects.
  const path = pathname === '/' ? '/' : decodeURIComponent(pathname);
  const isPortalPath = path.endsWith('/');

  // Single-segment 24-char hex ObjectId → resolve to the page's actual path.
  const segments = path.split('/').filter(Boolean);
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

      {isPortalPath ? <PageList initialParams={{ path }} /> : <PageView path={path} revisionId={revisionId} />}
    </>
  );
}
