'use client';

import { type ListPagesRequest, PageStatusEnum, type PageWithRevision } from '@crowi/api-contract';
import { m } from '@paraglide/messages.js';
import { Compass, Folder, HelpCircle, Pencil, Plus } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { CreatePageListButton } from '@/components/create-page/create-page-dialog';
import { PageContent } from '@/components/page-view/page-content';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog';
import { ErrorAlert } from '@/components/ui/error-alert';
import { useAuth } from '@/lib/use-auth';
import { draftEditHref } from '@/lib/use-drafts';
import { pageDisplayName } from '@/lib/page-path';
import { usePageList } from '@/lib/use-page-list';
import type { PageListVariant } from './page-list-item';
import { PageListEmptyCard, PageListSectionHeader, PageRowsCard, PageRowsSkeleton } from './page-list-shared';
import { Pagination } from './pagination';
import { PageSortMenu } from './page-sort-menu';
import { PortalHeader, PortalOverline } from './portal-header';

/**
 * A portal document whose body leads with a level-1 heading lets that
 * heading stand as the single page title (the header strip carries no
 * title); otherwise we fall back to rendering the folder name so the
 * portal is never titleless.
 *
 * Checked against the persisted mdast (`renderedAst`) rather than the raw
 * markdown so both ATX (`# x`) and setext (`x\n===`) level-1 headings are
 * recognised — a raw-text regex would miss setext and reintroduce a
 * double title.
 */
function leadsWithH1(renderedAst: unknown): boolean {
  if (!renderedAst || typeof renderedAst !== 'object') return false;
  const children = (renderedAst as { children?: unknown }).children;
  if (!Array.isArray(children) || children.length === 0) return false;
  const first = children[0] as { type?: unknown; depth?: unknown } | null;
  return !!first && first.type === 'heading' && first.depth === 1;
}

interface PageListProps {
  initialParams?: Partial<ListPagesRequest>;
  variant?: PageListVariant;
  /**
   * Suppress the "Create Portal" CTA in the fallback header. Used for the
   * `/user/` member directory, where the path is reserved and a portal
   * document must not be created (see `Page.isCreatableName`).
   */
  disableCreatePortal?: boolean;
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

export function PageList({ initialParams = {}, variant = 'default', disableCreatePortal = false }: PageListProps) {
  const router = useRouter();
  const { user } = useAuth();
  const [params, setParams] = useState<ListPagesRequest>({
    limit: DEFAULT_PAGE_LIMIT,
    offset: 0,
    include_deleted: false,
    sort: 'updatedAt',
    order: 'desc',
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

  // Changing the sort resets to the first page — the offset into the old
  // ordering is meaningless under the new one.
  const handleSortChange = (next: { sort: ListPagesRequest['sort']; order: ListPagesRequest['order'] }) => {
    setParams((prev) => ({ ...prev, ...next, offset: 0 }));
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

  // Resolve the portal document to actually render. A draft portal is
  // never rendered as the portal card (it has no committed revision —
  // it showed a perpetual "Rendering…"); trash subtrees never render a
  // portal either (the server forces portalPage=null, but suppress here
  // too so the legacy isTrashPage UI is preserved).
  const rawPortalPage = isTrash ? undefined : (data?.portalPage as PageWithRevision | undefined);
  const isDraftPortal = rawPortalPage?.status === PageStatusEnum.DRAFT;
  const portalPage = rawPortalPage && !isDraftPortal ? rawPortalPage : undefined;

  // A draft portal the *current user* started: surface a "portal in
  // progress" header with a "continue editing" CTA into its draft editor.
  // Drafts created by someone else (only visible to admins, RFC-0004)
  // fall through to the normal "Create Portal" CTA — they aren't the
  // viewer's to continue.
  const portalCreatorId = typeof rawPortalPage?.creator === 'string' ? rawPortalPage.creator : rawPortalPage?.creator?._id;
  const ownDraftPortalId = isDraftPortal && user && portalCreatorId === user.id ? rawPortalPage?._id : undefined;

  // Empty: nothing to render in the portal slot and no children. Show a
  // minimal header so the user still sees breadcrumb / title + "no pages".
  if (!data || (data.pages.length === 0 && !portalPage && !ownDraftPortalId)) {
    return (
      <div className="space-y-6">
        {portalPath && <PortalFallbackHeader path={portalPath} showCreatePortal={!isTrash && !disableCreatePortal} />}
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
        <div>
          <PortalHeader page={portalPage} onEdit={() => router.push(`/_edit?page_id=${encodeURIComponent(portalPage._id)}`)} />
          <div className="mt-6">
            {/* The portal body's own leading heading is the page title.
                Only when it has none do we name the folder ourselves so
                the portal is never titleless. */}
            {!leadsWithH1(portalPage.revision?.renderedAst) && (
              <h1 className="mb-4 text-3xl font-bold leading-tight tracking-tight">{getPortalTitle(portalPage.path)}</h1>
            )}
            <PageContent page={portalPage} />
          </div>
        </div>
      ) : (
        portalPath && (
          <PortalFallbackHeader
            path={portalPath}
            showCreatePortal={!isTrash && !ownDraftPortalId && !disableCreatePortal}
            draftPortalId={disableCreatePortal ? undefined : ownDraftPortalId}
          />
        )
      )}

      {/* Children list */}
      {data.pages.length > 0 && (
        <section className="space-y-2">
          <PageListSectionHeader
            label={formatPageCount(data.pages.length, data.pager)}
            labelAction={!isTrash && !disableCreatePortal && portalPath && portalPath !== '/' && <CreatePageListButton path={portalPath} />}
            action={!isTrash && <PageSortMenu sort={params.sort} order={params.order} onChange={handleSortChange} />}
          />
          <PageRowsCard pages={data.pages} variant={variant} />
          <Pagination pager={data.pager} limit={params.limit} onPageChange={handlePageChange} />
        </section>
      )}
    </div>
  );
}

/**
 * Header shown when listing children of a path that has no (renderable)
 * portal document of its own (e.g. `/foo/` exists implicitly because
 * `/foo/bar` does). Mirrors the breadcrumb + title block PageHeader
 * provides for a real page.
 *
 * Right-side action depends on state:
 *   - `draftPortalId` set → the current user already has a draft portal
 *     in progress here; show a "portal in progress" caption + a
 *     "Continue editing" CTA into its draft editor.
 *   - else `showCreatePortal` → a "Create Portal" action + a "What is
 *     Portal?" help dialog (the legacy `page_list.html` side button).
 *     Suppressed for the trash variant.
 */
function PortalFallbackHeader({ path, showCreatePortal = false, draftPortalId }: { path: string; showCreatePortal?: boolean; draftPortalId?: string }) {
  const router = useRouter();
  const title = getPortalTitle(path);
  // Trailing slash + folder icon mark this view as "the children of a
  // folder", separating it visually from a real page view (which has
  // neither). The breadcrumb above already encodes the full path, so
  // we drop the redundant `<p>{path}</p>` row that used to sit here.
  const isRoot = path === '/';
  return (
    <div className="border-b pb-4">
      {/* No portal document here yet — the "Create Portal" CTA + folder
          title already say "this is a folder without a portal", so the
          PORTAL chip (reserved for an actual portal document) is omitted. */}
      <PortalOverline path={path} />
      <div className="mt-3 flex items-start justify-between gap-4">
        <div className="min-w-0">
          <h1 className="text-3xl font-bold flex items-center gap-2">
            <Folder className="h-7 w-7 text-muted-foreground shrink-0" aria-hidden="true" />
            <span>
              {title}
              {!isRoot && '/'}
            </span>
          </h1>
          {draftPortalId && <p className="mt-1 text-sm text-muted-foreground">{m['page_list.portal_draft_notice']()}</p>}
        </div>
        {draftPortalId ? (
          <Button size="sm" className="shrink-0" onClick={() => router.push(draftEditHref(draftPortalId))}>
            <Pencil className="mr-1 h-4 w-4" />
            {m['page_list.continue_portal_draft']()}
          </Button>
        ) : (
          showCreatePortal && <CreatePortalActions path={path} />
        )}
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
