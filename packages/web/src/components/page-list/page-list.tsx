'use client';

import { type ListPagesRequest, PageStatusEnum, type PageWithRevision } from '@crowi/api-contract';
import { m } from '@paraglide/messages.js';
import { Compass, Folder, HelpCircle, Plus } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { Breadcrumb } from '@/components/breadcrumb';
import { PageContent } from '@/components/page-view/page-content';
import { PageHeader } from '@/components/page-view/page-header';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog';
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

  // Resolve the portal document to actually render. Two cases are
  // treated as "no portal":
  //   - trash subtrees: the server forces portalPage=null, but suppress
  //     here too so the legacy isTrashPage UI is preserved even if the
  //     API ever returns one.
  //   - draft portals: a portal the current user started but hasn't
  //     published yet is visible to its creator (RFC-0004), but it has
  //     no committed revision to render (shows a perpetual "Rendering…"),
  //     so we don't surface it as the portal. The folder falls back to
  //     the "Create Portal" header instead.
  const rawPortalPage = isTrash ? undefined : (data?.portalPage as PageWithRevision | undefined);
  const portalPage = rawPortalPage && rawPortalPage.status !== PageStatusEnum.DRAFT ? rawPortalPage : undefined;

  // Empty: no (renderable) portal document and no children. Show a minimal
  // header so the user still sees breadcrumb / title, plus a "no pages" hint.
  if (!data || (data.pages.length === 0 && !portalPage)) {
    return (
      <div className="space-y-6">
        {portalPath && <PortalFallbackHeader path={portalPath} showCreatePortal={!isTrash} />}
        <PageListEmptyCard message={isTrash ? m['page_list.empty_trash']() : m['page_list.empty_default']()} />
      </div>
    );
  }

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
        portalPath && <PortalFallbackHeader path={portalPath} showCreatePortal={!isTrash} />
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
 *
 * When `showCreatePortal` is set, a "Create Portal" action + a "What is
 * Portal?" help dialog are offered — this is the entry point for turning
 * an implicit folder into a real portal page (the legacy `page_list.html`
 * "Create Portal" side button). Suppressed for the trash variant.
 */
function PortalFallbackHeader({ path, showCreatePortal = false }: { path: string; showCreatePortal?: boolean }) {
  const title = getPortalTitle(path);
  // Trailing slash + folder icon mark this view as "the children of a
  // folder", separating it visually from a real page view (which has
  // neither). The breadcrumb above already encodes the full path, so
  // we drop the redundant `<p>{path}</p>` row that used to sit here.
  const isRoot = path === '/';
  return (
    <div className="border-b pb-4">
      <Breadcrumb path={path} />
      <div className="mt-1 flex items-start justify-between gap-4">
        <h1 className="text-3xl font-bold flex items-center gap-2">
          <Folder className="h-7 w-7 text-muted-foreground shrink-0" aria-hidden="true" />
          <span>
            {title}
            {!isRoot && '/'}
          </span>
        </h1>
        {showCreatePortal && <CreatePortalActions path={path} />}
      </div>
    </div>
  );
}

/**
 * "Create Portal" button + "What is Portal?" help dialog, shown when the
 * current folder path has no portal document yet. The button routes to the
 * standard create flow at the portal path (the path already ends with `/`,
 * which is exactly what makes the resulting page a portal — see
 * `Page.isPortalPath`). The help dialog reproduces the legacy "What is
 * Portal?" explanation.
 */
function CreatePortalActions({ path }: { path: string }) {
  const router = useRouter();
  // The portal page lives at the trailing-slash path itself. `normalizePath`
  // on the API side preserves the trailing slash, so `/_edit?path=/foo/`
  // creates the portal for `/foo/`.
  const portalPath = path.endsWith('/') ? path : `${path}/`;

  return (
    <div className="flex shrink-0 items-center gap-1">
      <Button size="sm" onClick={() => router.push(`/_edit?path=${encodeURIComponent(portalPath)}`)}>
        <Plus className="mr-1 h-4 w-4" />
        {m['page_list.create_portal']()}
      </Button>
      <Dialog>
        <DialogTrigger asChild>
          <Button variant="ghost" size="icon" aria-label={m['page_list.what_is_portal']()} title={m['page_list.what_is_portal']()}>
            <HelpCircle className="h-4 w-4 text-muted-foreground" />
          </Button>
        </DialogTrigger>
        <DialogContent>
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Compass className="h-5 w-5 text-primary" />
              {m['page_list.portal_help_title']()}
            </DialogTitle>
            <DialogDescription>{m['page_list.portal_help_intro']()}</DialogDescription>
          </DialogHeader>
          <ul className="list-disc space-y-2 pl-5 text-sm text-muted-foreground">
            <li>{m['page_list.portal_help_point_path']()}</li>
            <li>{m['page_list.portal_help_point_usage']()}</li>
            <li>{m['page_list.portal_help_point_optional']()}</li>
          </ul>
          <DialogFooter>
            <DialogClose asChild>
              <Button variant="outline">{m['page_list.portal_help_close']()}</Button>
            </DialogClose>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
