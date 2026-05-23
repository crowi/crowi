'use client';

import type { ListPagesRequest, PageWithRevision } from '@crowi/api-contract';
import { m } from '@paraglide/messages.js';
import { Compass } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { Breadcrumb } from '@/components/breadcrumb';
import { PageContent } from '@/components/page-view/page-content';
import { PageHeader } from '@/components/page-view/page-header';
import { Card } from '@/components/ui/card';
import { ErrorAlert } from '@/components/ui/error-alert';
import { pageDisplayName } from '@/lib/page-path';
import { usePageList } from '@/lib/use-page-list';
import type { PageListVariant } from './page-list-item';
import { PageListEmptyCard, PageListSectionHeader, PageRowsCard, PageRowsSkeleton } from './page-list-shared';
import { Pagination } from './pagination';

interface PageListProps {
  initialParams?: Partial<ListPagesRequest>;
  variant?: PageListVariant;
}

// Default page size for the main directory listing. The 2-line dense
// rows fit ~100 entries in a comfortable scroll, so we ship a roomy
// default and let the API impose its own hard cap.
const DEFAULT_PAGE_LIMIT = 100;

function getPortalTitle(path: string): string {
  if (path === '/') return m['page_list.title_all']();
  return pageDisplayName(path) || m['page_list.title_default']();
}

/**
 * The pager carries `prev/next/offset` but no total. When the first page
 * is the only page (`offset === 0 && next === null`), `data.pages.length`
 * IS the total — show it as "N 件のページ". Otherwise we only know there's
 * more, so flip to "N 件以上のページ" to avoid misreading the slice count
 * as a directory size.
 */
function formatPageCount(count: number, pager: { offset: number; next: number | null }): string {
  const knownTotal = pager.offset === 0 && pager.next === null;
  return knownTotal ? m['page_list.page_count']({ count }) : m['page_list.page_count_more']({ count });
}

export function PageList({ initialParams = {}, variant = 'default' }: PageListProps) {
  const router = useRouter();
  const [params, setParams] = useState<ListPagesRequest>({
    limit: DEFAULT_PAGE_LIMIT,
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
    return (
      <div role="status" aria-live="polite" aria-label={m['page_list.loading']()} className="space-y-6">
        <Card className="gap-0 overflow-hidden py-0" aria-hidden>
          <div className="space-y-3 p-6">
            <div className="h-3 w-20 animate-pulse rounded bg-muted" />
            <div className="h-8 w-2/3 animate-pulse rounded bg-muted" />
            <div className="h-4 w-full animate-pulse rounded bg-muted" />
          </div>
        </Card>
        <PageRowsSkeleton />
      </div>
    );
  }

  if (error) {
    return <ErrorAlert message={m['page_list.failed_to_load']()} />;
  }

  // Empty: no portal document and no children. Show a minimal header so the
  // user still sees breadcrumb / title, plus a "no pages" hint.
  if (!data || (data.pages.length === 0 && !data.portalPage)) {
    return (
      <div className="space-y-6">
        {portalPath && <PortalFallbackHeader path={portalPath} />}
        <PageListEmptyCard message={isTrash ? m['page_list.empty_trash']() : m['page_list.empty_default']()} />
      </div>
    );
  }

  // /trash subtrees never expose a portal document (server forces portalPage=null
  // for /trash paths). Suppress portal rendering entirely for the trash variant
  // so the legacy isTrashPage UI is preserved even if the API ever returns one.
  const portalPage = isTrash ? undefined : (data.portalPage as PageWithRevision | undefined);

  return (
    <div className="space-y-6">
      {/* Portal document — its own body + page-level actions (rename / delete /
          like / bookmark / watch) come from the shared PageHeader, so the
          portal can be operated exactly like a normal page. */}
      {portalPage ? (
        <Card className="gap-0 overflow-hidden py-0">
          <div className="p-6">
            <div className="mb-3 flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wider text-primary">
              <Compass className="h-3.5 w-3.5" />
              {m['page_list.portal_label']()}
            </div>
            <PageHeader page={portalPage} onEdit={() => router.push(`/_edit?page_id=${encodeURIComponent(portalPage._id)}`)} showActions />
            <PageContent page={portalPage} />
          </div>
        </Card>
      ) : (
        portalPath && <PortalFallbackHeader path={portalPath} />
      )}

      {/* Children list */}
      {data.pages.length > 0 && (
        <section className="space-y-2">
          <PageListSectionHeader label={formatPageCount(data.pages.length, data.pager)} />
          <PageRowsCard pages={data.pages} variant={variant} />
          <Pagination pager={data.pager} limit={params.limit} onPageChange={handlePageChange} />
        </section>
      )}
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
      <p className="text-muted-foreground text-sm mt-1 font-mono">{path}</p>
    </div>
  );
}
