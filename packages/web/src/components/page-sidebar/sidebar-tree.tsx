'use client';

import type { PageChildSegment } from '@crowi/api-contract';
import { CornerLeftUp } from 'lucide-react';
import Link from 'next/link';
import { useEffect, useMemo, useRef, useState } from 'react';
import { m } from '@paraglide/messages.js';
import { usePageChildrenLevels } from '@/lib/use-page-children';
import { cn } from '@/lib/utils';
import { pageDisplayName, pagePathToHref } from '@/lib/page-path';
import { SidebarRowLink, SidebarSelfLinkRow } from './sidebar-row';
import { SidebarUserHome } from './sidebar-user-home';
import { deepChildRowsOf, folderPageSelfLink, MEMBER_DIR_PATH, monthLevelIndex, pageSidebarLayout, resolveSidebarSelfLinks } from './sidebar-paths';
import { SIDEBAR_SCROLLER_ATTR, scrollOffsetToCenter } from './sidebar-scroll';

/**
 * The page sidebar hierarchy — the current path's ancestry as an
 * expanded tree, identical for list (portal) and content pages (see
 * `pageSidebarLayout`). Each ancestor directory's children are fetched
 * in parallel; the branch toward the current node is opened down to it.
 * A "⤴" affordance tops a normal tree; inside a user's space the user's
 * home tops it instead (user icon, no ⤴).
 *
 * One level breaks the "active branch only" rule: a `YYYY/MM/` node
 * (`dateMonthPath`) opens EVERY day of the month, each showing the pages
 * inside it. Crowi's flow-note idiom leaves one or two pages under each
 * day, so the plain tree degenerates into a column of bare day numbers
 * that says nothing about what is in them. Only the non-active days are
 * drawn from the month's deeper fetch; the day you are on keeps coming
 * from its own level, so the current-node highlight and the self-link
 * below are untouched by this.
 */
export function SidebarTree({ path }: { path: string }) {
  const layout = useMemo(() => pageSidebarLayout(path), [path]);
  // The month level is fetched two deep (days AND their pages) in the one
  // request that would have fetched the days alone.
  const monthIndex = monthLevelIndex(layout, path);
  const depths = layout.levelPaths.map((_, index) => (index === monthIndex ? 2 : 1));
  const results = usePageChildrenLevels(layout.levelPaths, depths);
  // `isPending`, not `isLoading`: a query paused while offline has no data
  // either, but is not fetching, so `isLoading` would call it done.
  const isPending = results.some((r) => r.isPending);
  // Positionally aligned with layout.levelPaths. A level whose fetch failed
  // has no rows and draws as empty.
  const fetched = results.map((r) => r.data?.children);

  // A page change nearly always brings a level nothing has fetched yet — the
  // new node's own children — so the tree would drop to the skeleton on
  // almost every navigation, and the flyout panel, which sizes itself to this
  // content, would visibly collapse and grow back around it. Until every
  // level of the new path is in, keep drawing the last tree that was
  // complete; it moves over in one step once they arrive. Stored during
  // render rather than in an effect, so it is kept in the same commit that
  // draws it.
  const [settled, setSettled] = useState<SidebarTreeViewProps | null>(null);
  const isSettled = settled?.path === path && settled.fetched.every((rows, index) => rows === fetched[index]);
  if (!isPending && !isSettled) setSettled({ path, fetched });

  // A render that stores a snapshot is discarded and re-run, so by the time
  // one commits, `settled` is the newest complete tree there is.
  if (settled === null) {
    return (
      <div className="space-y-1.5" aria-hidden>
        {Array.from({ length: 6 }).map((_, i) => (
          <div key={i} className="h-5 animate-pulse rounded bg-muted/60" style={{ marginLeft: `${Math.min(i, 3) * 0.5}rem` }} />
        ))}
      </div>
    );
  }
  return <SidebarTreeView {...settled} />;
}

interface SidebarTreeViewProps {
  path: string;
  fetched: (PageChildSegment[] | undefined)[];
}

/** The tree for one path whose levels have all been fetched. */
function SidebarTreeView({ path, fetched }: SidebarTreeViewProps) {
  const layout = useMemo(() => pageSidebarLayout(path), [path]);
  const monthIndex = monthLevelIndex(layout, path);
  const levels = fetched.map((rows) => rows ?? []);
  // The same levels narrowed to each level's DIRECT children. Only the
  // month level can differ (its response spans two levels), but taking
  // this uniformly keeps every consumer below reading one kind of list.
  const directLevels = levels.map((rows, index) => deepChildRowsOf(rows, layout.levelPaths[index]));

  // An open folder node `x/` that is also a content page links to the portal
  // listing `/…/x/`, leaving the content page at `/…/x` unreachable. Surface
  // it as the first child under `x/`. When the viewer is on the current
  // node's content page, that self-link is the current row (so the folder
  // node yields the highlight to it — see `hasCurrentSelfLink` below).
  const selfLinks = resolveSidebarSelfLinks(layout, directLevels, path);
  // Only the current node's own self-link is ever marked current, so any
  // marked one means the folder row hands its highlight over.
  const hasCurrentSelfLink = selfLinks.some((link) => link?.isCurrent);

  // The user-home node occupies depth 0, so its space's levels nest under
  // it one step deeper.
  const baseDepth = layout.userHome ? 1 : 0;

  const containerRef = useRef<HTMLDivElement>(null);
  // A fully-opened month runs to dozens of rows, well past the rail's
  // height, so the node you are on can land outside the viewport with
  // nothing to say the tree even moved. Bring it into view once per path —
  // once only, so a background refetch never yanks the rail out from under
  // someone who has scrolled it themselves.
  const scrolledForPath = useRef<string | null>(null);
  useEffect(() => {
    if (scrolledForPath.current === path) return;
    const root = containerRef.current;
    const current = root?.querySelector<HTMLElement>('[aria-current="page"]');
    const scroller = root?.closest<HTMLElement>(`[${SIDEBAR_SCROLLER_ATTR}]`);
    if (!root || !current || !scroller) return;
    scrolledForPath.current = path;
    scroller.scrollTop += scrollOffsetToCenter(current.getBoundingClientRect(), scroller.getBoundingClientRect());
  }, [path]);

  // The pages of one non-active day, taken from the month level's deeper
  // fetch. A day the viewer is not on can never hold the current node, so
  // these rows need no active state.
  const renderMonthDay = (day: PageChildSegment): React.ReactNode => {
    const pages = deepChildRowsOf(levels[monthIndex], day.path);
    if (pages.length === 0) return null;
    const selfLink = folderPageSelfLink(day);
    return (
      <ul className="space-y-0.5">
        {selfLink && (
          <li key="__self__">
            <SidebarSelfLinkRow link={selfLink} depth={monthIndex + 1 + baseDepth} />
          </li>
        )}
        {pages.map((page) => (
          <li key={page.segment}>
            <SidebarRowLink segment={page} depth={monthIndex + 1 + baseDepth} />
          </li>
        ))}
      </ul>
    );
  };

  // Recursively render the tree from level `k` down, opening only the
  // active branch at each level.
  const renderLevel = (k: number): React.ReactNode => {
    // The member directory (/user/) is a special roster, not a tree node —
    // drop it wherever it would appear (only ever at the top level).
    const children = (directLevels[k] ?? []).filter((c) => c.path !== MEMBER_DIR_PATH);
    const isDeepest = k === layout.levelPaths.length - 1;
    // The opened parent folder's content-page self-link, injected at the
    // top of this listing.
    const selfLink = selfLinks[k];
    if (children.length === 0 && !selfLink) return null;
    const activeSegment = layout.activeSegments[k];

    return (
      <ul className="space-y-0.5">
        {selfLink && (
          <li key="__self__">
            <SidebarSelfLinkRow link={selfLink} depth={k + baseDepth} />
          </li>
        )}
        {children.map((child) => {
          const isActive = activeSegment !== null && child.segment === activeSegment;
          // The folder node yields its highlight to the self-link when the
          // viewer is on the content page itself.
          const isCurrent = k === layout.currentLevelIndex && child.segment === layout.currentSegment && !hasCurrentSelfLink;
          return (
            <li key={child.segment}>
              <SidebarRowLink segment={child} depth={k + baseDepth} isCurrent={isCurrent} isOpen={isActive && !isCurrent} />
              {isActive && !isDeepest && renderLevel(k + 1)}
              {!isActive && k === monthIndex && renderMonthDay(child)}
            </li>
          );
        })}
      </ul>
    );
  };

  return (
    <div ref={containerRef} className="space-y-0.5">
      {layout.userHome && (
        // The user's home tops their space — a node (avatar), not a ⤴,
        // since the roster is reached from the nav links. Highlighted when
        // it is itself the current page.
        <SidebarUserHome username={layout.userHome} isCurrent={layout.currentLevelIndex === -1} isOpen={layout.currentLevelIndex !== -1} />
      )}
      {layout.upPath && (
        <Link
          href={pagePathToHref(layout.upPath)}
          title={layout.upPath}
          className={cn(
            'flex items-center gap-1.5 rounded-md px-2 py-1 text-xs text-muted-foreground transition-colors',
            'hover:bg-muted/60 hover:text-foreground',
          )}
        >
          <CornerLeftUp className="h-3.5 w-3.5 shrink-0" aria-hidden />
          <span className="truncate">{pageDisplayName(layout.upPath) || m['sidebar.up_to_parent']()}</span>
        </Link>
      )}
      {renderLevel(0)}
    </div>
  );
}
