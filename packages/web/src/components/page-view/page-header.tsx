'use client';

import { Button } from '@/components/ui/button';
import { Breadcrumb } from '@/components/breadcrumb';
import { ArrowUp, Lock, Edit2 } from 'lucide-react';
import type { PageWithRevision } from '@crowi/api-contract';
import { PageGrantEnum } from '@crowi/api-contract';
import { useAuth } from '@/lib/use-auth';
import { useMeasuredHeight, useStickyHeader } from '@/lib/use-sticky-header';
import { cn } from '@/lib/utils';
import { m } from '@paraglide/messages.js';
import { BookmarkButton } from './bookmark-button';
import { LikeButton } from './like-button';
import { LinkSharePopover } from './link-share-popover';
import { LivePresenceRow } from './live-presence-row';
import { MetaChipRow } from './meta-chip-row';
import { PageActionsMenu } from './page-actions-menu';
import { WatchButton } from './watch-button';

interface PageHeaderProps {
  page: PageWithRevision;
  onEdit?: () => void;
  showActions?: boolean;
  /**
   * `false` hides the restructured meta-chip row (author / timestamp /
   * like / view / comment / backlink chips). Used by /user/<username>
   * covers where the chips would be noise.
   */
  showMeta?: boolean;
  /**
   * `false` hides the H1 title row (used by /user/<username>: the
   * cover above already names the user, and the page title would
   * just echo the URL basename).
   */
  showTitle?: boolean;
  /**
   * RFC-0005 live presence row above the title. Defaults on for the
   * live page view; callers rendering a stale revision / deleted page
   * / user cover pass `false` — presence is only meaningful for the
   * page someone is actually reading right now.
   */
  showPresence?: boolean;
  /**
   * `false` opts out of the sticky / compact behaviour — the header
   * renders inline in its expanded form and no fixed overlay is
   * mounted. Used by the deleted-page and user-cover hosts where
   * pinning a header makes no sense.
   */
  sticky?: boolean;
}

function getPageTitle(path: string): string {
  if (path === '/') return 'Home';
  const segments = path.split('/').filter(Boolean);
  return segments[segments.length - 1] || 'Untitled';
}

export function PageHeader({ page, onEdit, showActions = false, showMeta = true, showTitle = true, showPresence = false, sticky = false }: PageHeaderProps) {
  const { user, isAuthenticated } = useAuth();

  // ── Sticky-header machinery ───────────────────────────────────────────
  // `H` — the expanded header's flow height — is measured off the
  // expanded layout wrapper below. It is the ONE number that keeps
  // document flow constant across the expanded⇄compact toggle:
  //
  //   • while compact, the visible header is `position: fixed` (out of
  //     flow) and a placeholder of exactly `H` fills its former slot,
  //     so the main content never moves;
  //   • the compact trigger is `scrollY >= H` — and because flow (hence
  //     `scrollY`) is constant across the toggle, the trigger cannot
  //     feed back on itself. No flicker at the boundary.
  //
  // The expanded wrapper stays in normal flow at its natural width in
  // every state, so the ResizeObserver measures the same `H` whether or
  // not the page is compacted — the toggle never disturbs `H`.
  const { ref: measureRef, height: expandedHeight } = useMeasuredHeight();
  const { compact: scrolled } = useStickyHeader(expandedHeight);
  const compact = sticky && scrolled;

  const isLiked = isAuthenticated && !!user && (page.liker ?? []).includes(user.id);
  const isPrivate = page.grant === PageGrantEnum.OWNER || page.grant === PageGrantEnum.SPECIFIED;
  const pageTitle = getPageTitle(page.path);

  const editButton = onEdit && (
    <Button variant="ghost" size="sm" onClick={onEdit} className="shrink-0 text-muted-foreground hover:text-foreground">
      <Edit2 className="h-4 w-4 mr-1" />
      {m['page.action_edit']()}
    </Button>
  );

  const editIconButton = onEdit && (
    <Button
      variant="ghost"
      size="icon-sm"
      onClick={onEdit}
      aria-label={m['page.action_edit']()}
      title={m['page.action_edit']()}
      className="shrink-0 text-muted-foreground hover:text-foreground"
    >
      <Edit2 className="h-4 w-4" />
    </Button>
  );

  // The expanded layout. Rendered inside the measurement wrapper, which
  // is always in normal flow at its natural width — so `H` is stable.
  // While compact this wrapper is visually hidden (but still occupies
  // flow) and the fixed compact bar is shown on top of the placeholder.
  const expandedHeader = (
    <div className="space-y-5" data-testid="page-header-expanded">
      {/* Breadcrumb + action buttons. On mobile they stack vertically —
          side by side they overflow the viewport (the action group is
          `shrink-0`); from `md` up they share one row. */}
      <div className="flex flex-col gap-2 md:flex-row md:items-center md:justify-between md:gap-4 min-h-9">
        <Breadcrumb path={page.path} />

        <div className="flex items-center gap-1 shrink-0">
          {isAuthenticated && <LikeButton pageId={page._id} isLiked={isLiked} />}
          {/* watch / bookmark / link are hidden on mobile in the
              expanded header — they fold into the dotmenu instead. */}
          {isAuthenticated && (
            <span className="hidden md:inline-flex">
              <WatchButton pageId={page._id} />
            </span>
          )}
          <span className="hidden md:inline-flex">
            <BookmarkButton pageId={page._id} />
          </span>
          <span className="hidden md:inline-flex">
            <LinkSharePopover page={page} />
          </span>
          {showActions && (
            <>
              <span className="md:hidden">
                <PageActionsMenu page={page} compact isAuthenticated={isAuthenticated} />
              </span>
              <span className="hidden md:inline-flex">
                <PageActionsMenu page={page} isAuthenticated={isAuthenticated} />
              </span>
            </>
          )}
        </div>
      </div>

      {showPresence && isAuthenticated && <LivePresenceRow pageId={page._id} />}

      {showTitle ? (
        <div className="flex items-center gap-3">
          <h1 className="text-3xl md:text-[2.5rem] font-bold tracking-tight leading-[1.15] text-foreground flex-1 min-w-0">{pageTitle}</h1>
          {isPrivate && <Lock className="h-5 w-5 text-muted-foreground shrink-0" aria-label="Private page" />}
          {editButton}
        </div>
      ) : (
        (isPrivate || onEdit) && (
          <div className="flex items-center justify-end gap-3">
            {isPrivate && <Lock className="h-5 w-5 text-muted-foreground shrink-0" aria-label="Private page" />}
            {editButton}
          </div>
        )
      )}

      {showMeta && <MetaChipRow page={page} />}
    </div>
  );

  // Non-sticky hosts (deleted page / user cover): just the inline
  // expanded header, no compaction, no measurement consumers.
  if (!sticky) {
    return (
      <header data-compact="false">
        <div ref={measureRef}>{expandedHeader}</div>
      </header>
    );
  }

  return (
    <header data-compact={compact}>
      {/*
        Measurement wrapper. ALWAYS in normal flow at natural width, so
        the ResizeObserver always sees the true expanded height `H`.

        • Expanded: visible — this IS the page header.
        • Compact: kept in flow but `invisible` — it then doubles as the
          placeholder spacer (its height is, by construction, exactly
          `H`), so the main content's flow position is byte-identical
          whether expanded or compact. Compacting shifts NOTHING.

        Because the wrapper is never detached and never resized by the
        toggle, `scrollY` is constant across it — and the `scrollY >= H`
        trigger in `useStickyHeader` therefore cannot oscillate.
      */}
      <div ref={measureRef} data-testid="sticky-header-placeholder" aria-hidden={compact} className={cn(compact && 'invisible')}>
        {expandedHeader}
      </div>

      {/* Compact header — a `position: fixed` bar, out of flow, shown
          only while compact. Showing / hiding it never moves any
          content. It sits below the `(auth)` app header (`z-40`) at
          `z-30`; the app header is not sticky, so by the time we are
          compacted (scrolled past `H`) the viewport top is free.

          compact layout = path-tail title + icon-only like/edit +
          dotmenu (watch / bookmark / link collapsed in) + presence row
          at compact size. */}
      {compact && (
        <div
          data-testid="page-header-compact"
          className={cn(
            'fixed inset-x-0 top-0 z-30 bg-background shadow-header',
            'transition-[opacity,transform] duration-150 ease-out motion-reduce:transition-none',
          )}
        >
          {/* Match the (auth) layout content width / gutters so the
              compact header lines up with the article column. */}
          <div className="max-w-4xl mx-auto px-4 py-2 space-y-2">
            <div className="flex items-center gap-2">
              {/* Scroll-to-top — sits to the left of the title, hanging
                  out past the content gutter (`-ml-9`). */}
              <button
                type="button"
                onClick={() => window.scrollTo({ top: 0, behavior: 'smooth' })}
                aria-label={m['page.scroll_to_top']()}
                className="-ml-9 shrink-0 rounded-full p-1.5 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                <ArrowUp className="h-4 w-4" />
              </button>
              <h1 className="text-base md:text-lg font-semibold tracking-tight text-foreground flex-1 min-w-0 truncate">{pageTitle}</h1>
              {isPrivate && <Lock className="h-4 w-4 text-muted-foreground shrink-0" aria-label="Private page" />}
              <div className="flex items-center gap-1 shrink-0">
                {isAuthenticated && <LikeButton pageId={page._id} isLiked={isLiked} iconOnly />}
                {editIconButton}
                {showActions && <PageActionsMenu page={page} compact isAuthenticated={isAuthenticated} />}
              </div>
            </div>
            {showPresence && isAuthenticated && <LivePresenceRow pageId={page._id} size="compact" />}
          </div>
        </div>
      )}
    </header>
  );
}
