'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Card } from '@/components/ui/card';
import { LoadingSpinner } from '@/components/ui/loading-spinner';
import { ErrorAlert } from '@/components/ui/error-alert';
import { Breadcrumb } from '@/components/breadcrumb';
import { PageListItem } from './page-list-item';
import { Pagination } from './pagination';
import { PageContent } from '@/components/page-view/page-content';
import { PageHeader } from '@/components/page-view/page-header';
import { usePageList } from '@/lib/use-page-list';
import type { ListPagesRequest, PageWithRevision } from '@crowi/api-contract';

type PageListVariant = 'default' | 'trash';

interface PageListProps {
  initialParams?: Partial<ListPagesRequest>;
  variant?: PageListVariant;
}

function getPortalTitle(path: string): string {
  if (path === '/') return 'All Pages';
  const cleanPath = path.replace(/\/$/, '');
  const segments = cleanPath.split('/').filter(Boolean);
  return segments.length > 0 ? segments[segments.length - 1] : 'Pages';
}

export function PageList({ initialParams = {}, variant = 'default' }: PageListProps) {
  const router = useRouter();
  const [params, setParams] = useState<ListPagesRequest>({
    limit: 50,
    offset: 0,
    include_deleted: false,
    ...initialParams,
  });
  const portalPath = params.path;
  const isTrash = variant === 'trash';

  const { data, isLoading, error } = usePageList(params);

  const handlePageChange = (offset: number) => {
    setParams((prev) => ({ ...prev, offset }));
    // Scroll to top when page changes
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };

  if (isLoading) {
    return <LoadingSpinner message="Loading pages..." className="py-12" />;
  }

  if (error) {
    return <ErrorAlert message="Failed to load pages. Please try again later." />;
  }

  // Empty: no portal document and no children. Show a minimal header so the
  // user still sees breadcrumb / title, plus a "no pages" hint.
  if (!data || (data.pages.length === 0 && !data.portalPage)) {
    return (
      <div className="space-y-4">
        {portalPath && <PortalFallbackHeader path={portalPath} />}
        <Card className="p-8 text-center">
          <p className="text-muted-foreground">{isTrash ? 'No deleted pages.' : 'No pages found.'}</p>
        </Card>
      </div>
    );
  }

  // /trash subtrees never expose a portal document (server forces portalPage=null
  // for /trash paths). Suppress portal rendering entirely for the trash variant
  // so the legacy isTrashPage UI is preserved even if the API ever returns one.
  const portalPage = isTrash ? undefined : (data.portalPage as PageWithRevision | undefined);

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
            <PageListItem key={page._id} page={page} variant={variant} />
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
