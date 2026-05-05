'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Loader2, AlertCircle } from 'lucide-react';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Card } from '@/components/ui/card';
import { Breadcrumb } from '@/components/breadcrumb';
import { PageListItem } from './page-list-item';
import { Pagination } from './pagination';
import { PageContent } from '@/components/page-view/page-content';
import { PageHeader } from '@/components/page-view/page-header';
import { usePageList } from '@/lib/use-page-list';
import type { ListPagesRequest, PageWithRevision } from '@crowi/api-contract';

interface PageListProps {
  initialParams?: Partial<ListPagesRequest>;
}

function getPortalTitle(path: string): string {
  if (path === '/') return 'All Pages';
  const cleanPath = path.replace(/\/$/, '');
  const segments = cleanPath.split('/').filter(Boolean);
  return segments.length > 0 ? segments[segments.length - 1] : 'Pages';
}

export function PageList({ initialParams = {} }: PageListProps) {
  const router = useRouter();
  const [params, setParams] = useState<ListPagesRequest>({
    limit: 50,
    offset: 0,
    ...initialParams,
  });
  const portalPath = params.path;

  const { data, isLoading, error } = usePageList(params);

  const handlePageChange = (offset: number) => {
    setParams((prev) => ({ ...prev, offset }));
    // Scroll to top when page changes
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-12">
        <Loader2 className="h-8 w-8 animate-spin text-primary" />
        <span className="ml-2 text-muted-foreground">Loading pages...</span>
      </div>
    );
  }

  if (error) {
    return (
      <Alert variant="destructive">
        <AlertCircle className="h-4 w-4" />
        <AlertDescription>Failed to load pages. Please try again later.</AlertDescription>
      </Alert>
    );
  }

  // Empty: no portal document and no children. Show a minimal header so the
  // user still sees breadcrumb / title, plus a "no pages" hint.
  if (!data || (data.pages.length === 0 && !data.portalPage)) {
    return (
      <div className="space-y-4">
        {portalPath && <PortalFallbackHeader path={portalPath} />}
        <Card className="p-8 text-center">
          <p className="text-muted-foreground">No pages found.</p>
        </Card>
      </div>
    );
  }

  const portalPage = data.portalPage as PageWithRevision | undefined;

  return (
    <div className="space-y-4">
      {/* Portal page header + body when the portal itself exists */}
      {portalPage ? (
        <Card>
          <div className="p-6">
            <PageHeader page={portalPage} onEdit={() => router.push(`/edit?page_id=${encodeURIComponent(portalPage._id)}`)} showActions />
            <PageContent page={portalPage} />
          </div>
        </Card>
      ) : (
        portalPath && <PortalFallbackHeader path={portalPath} />
      )}

      {/* Children list */}
      {data.pages.length > 0 && (
        <Card className="divide-y">
          {data.pages.map((page) => (
            <PageListItem key={page._id} page={page} />
          ))}
        </Card>
      )}

      {/* Pagination */}
      {data.pages.length > 0 && <Pagination pager={data.pager} limit={params.limit} onPageChange={handlePageChange} />}
    </div>
  );
}

/**
 * Header shown when listing children of a path that has no portal document of
 * its own (e.g. `/foo/` exists implicitly because `/foo/bar` does).
 * Mirrors the breadcrumb + title block PageHeader provides for a real page.
 */
function PortalFallbackHeader({ path }: { path: string }) {
  return (
    <div className="border-b pb-4">
      <Breadcrumb path={path} />
      <h1 className="text-3xl font-bold">{getPortalTitle(path)}</h1>
      <p className="text-muted-foreground text-sm mt-1">{path}</p>
    </div>
  );
}
