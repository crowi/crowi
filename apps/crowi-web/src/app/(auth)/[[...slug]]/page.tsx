'use client';

import { usePathname, useSearchParams } from 'next/navigation';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Breadcrumb } from '@/components/breadcrumb';
import { IdRedirector } from '@/components/id-redirector';
import { PageList } from '@/components/page-list/page-list';
import { PageView } from '@/components/page-view';
import { PageHistoryView } from '@/components/page-history/page-history-view';
import { isObjectId } from '@/lib/object-id';

export default function CatchAllPage() {
  const pathname = usePathname();
  const searchParams = useSearchParams();

  // Check if we were redirected from another page
  const redirectFrom = searchParams.get('redirectFrom');

  // Determine the path for the page list or page view
  // For root /, use '/'
  // For other paths, decode the pathname to handle multibyte characters
  // Next.js usePathname() returns URL-encoded paths (e.g., /%E3%83%A6%E3%83%BC%E3%82%B6%E3%83%BC)
  // We need to decode them before using with the API
  const path = pathname === '/' ? '/' : decodeURIComponent(pathname);
  const isPortalPath = path.endsWith('/');

  // Detect /<24-char hex ObjectId> URLs and redirect to the page's actual path.
  const segments = path.split('/').filter(Boolean);
  if (segments.length === 1 && isObjectId(segments[0])) {
    return <IdRedirector pageId={segments[0]} />;
  }

  // Detect /:path/history sub-route. The catch-all owns the entire URL space, so
  // we recognize the trailing '/history' segment here rather than as a separate
  // route file (Next.js does not allow nesting under [[...slug]]).
  if (!isPortalPath && segments.length >= 2 && segments[segments.length - 1] === 'history') {
    const basePath = '/' + segments.slice(0, -1).join('/');
    return <PageHistoryView path={basePath} />;
  }

  // Determine page title for portal views
  const getPortalTitle = (portalPath: string): string => {
    if (portalPath === '/') return 'All Pages';
    // Remove trailing slash and get last segment
    const cleanPath = portalPath.replace(/\/$/, '');
    const segments = cleanPath.split('/').filter(Boolean);
    return segments.length > 0 ? segments[segments.length - 1] : 'Pages';
  };

  return (
    <>
      {/* Show redirect notice if we came from a redirected page */}
      {redirectFrom && (
        <Alert className="mb-6">
          <AlertDescription>
            Redirected from <code className="bg-muted px-2 py-0.5 rounded">{redirectFrom}</code>
          </AlertDescription>
        </Alert>
      )}

      {isPortalPath ? (
        // Portal/Directory view - shows page list
        <>
          <div className="mb-6">
            <Breadcrumb path={path} />
            <h1 className="text-3xl font-bold">{getPortalTitle(path)}</h1>
            <p className="text-muted-foreground mt-1">{path}</p>
          </div>
          <PageList initialParams={{ path }} />
        </>
      ) : (
        // Single page view
        <PageView path={path} />
      )}
    </>
  );
}
