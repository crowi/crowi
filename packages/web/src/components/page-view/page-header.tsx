'use client';

import type { PageWithRevision, TocEntryResponse } from '@crowi/api-contract';
import { PageGrantEnum, PageStatusEnum } from '@crowi/api-contract';
import { isLinkOnlyGrant, isPrivateGrant } from '@/lib/page-grant';
import { m } from '@paraglide/messages.js';
import { ArrowUp, Edit2, Link2, Lock } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { Breadcrumb } from '@/components/breadcrumb';
import { Button } from '@/components/ui/button';
import { pageDisplayName } from '@/lib/page-path';
import { useAuth } from '@/lib/use-auth';
import type { UsePresenceResult } from '@/lib/use-presence';
import { useMeasuredHeight, useStickyHeader } from '@/lib/use-sticky-header';
import { useWideViewport } from '@/lib/use-wide-viewport';
import { cn } from '@/lib/utils';
import type { LucideIcon } from 'lucide-react';
import { BookmarkButton } from './bookmark-button';
import { LikeButton } from './like-button';
import { LinkSharePopover } from './link-share-popover';
import { LivePresenceRow } from './live-presence-row';
import { MetaChipRow } from './meta-chip-row';
import { MobilePresenceCard } from './mobile-presence-card';
import { PageActionsMenu } from './page-actions-menu';
import { PageTocMenu } from './page-toc-menu';
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
   * The result of `usePresence(pageId)`, hoisted to the PageView so a
   * single `/presence` WebSocket is shared across the expanded / compact
   * header rows (feature-live-page-content-sync lift). Optional because
   * the deleted-page and user-cover hosts render PageHeader without
   * presence (they pass `showPresence` false, so the row is never shown);
   * only the live view supplies it. The `LivePresenceRow` gate narrows
   * `undefined` away before rendering.
   */
  presence?: UsePresenceResult;
  /**
   * `false` opts out of the sticky / compact behaviour — the header
   * renders inline in its expanded form and no fixed overlay is
   * mounted. Used by the deleted-page and user-cover hosts where
   * pinning a header makes no sense.
   */
  sticky?: boolean;
  /**
   * Page TOC + its shared scroll-spy active id. Used to render the
   * collapsed `PageTocMenu` ("目次" popover) in the header when the
   * right-rail TOC is hidden (< 1280px). Omitted by non-page hosts
   * (deleted page / user cover) — the menu then never renders.
   */
  toc?: TocEntryResponse[];
  activeTocId?: string | null;
}

function getPageTitle(path: string): string {
  if (path === '/') return 'Home';
  return pageDisplayName(path) || 'Untitled';
}

/**
 * Resolve the icon + chip label for a page's grant. RESTRICTED uses a
 * link icon because "anyone with the link" is the sharing posture;
 * SPECIFIED / OWNER use the lock icon. Returns `null` for PUBLIC so
 * callers can short-circuit rendering.
 */
function grantChipInfo(grant: number | undefined): { Icon: LucideIcon; label: string } | null {
  if (grant === PageGrantEnum.RESTRICTED) {
    return { Icon: Link2, label: m['page.grant_chip_restricted']() };
  }
  if (grant === PageGrantEnum.SPECIFIED) {
    return { Icon: Lock, label: m['page.grant_chip_specified']() };
  }
  if (grant === PageGrantEnum.OWNER) {
    return { Icon: Lock, label: m['page.grant_chip_owner']() };
  }
  return null;
}

/**
 * Pill chip next to the page title that names the page's sharing
 * posture and picks up `--page-grant-accent` for border + text + icon.
 * Companion to the thin accent strip in `(auth)/layout.tsx` — both
 * read the same CSS variable so the colour stays consistent.
 */
export function GrantChip({ grant }: { grant: number }) {
  const info = grantChipInfo(grant);
  if (!info) return null;
  const { Icon, label } = info;
  return (
    <span
      className="inline-flex shrink-0 items-center gap-1 whitespace-nowrap rounded-full border px-2 py-0.5 text-xs font-medium"
      style={{ borderColor: 'var(--page-grant-accent)', color: 'var(--page-grant-accent)' }}
    >
      <Icon className="h-3 w-3" aria-hidden="true" />
      {label}
    </span>
  );
}

export function PageHeader({
  page,
  onEdit,
  showActions = false,
  showMeta = true,
  showTitle = true,
  showPresence = false,
  sticky = false,
  toc = [],
  activeTocId = null,
  presence,
}: PageHeaderProps) {
  const { user, isAuthenticated } = useAuth();

  // feature-mobile-presence-card — the header's mobile and desktop
  // presence surfaces are DIFFERENT DOM (not one tree styled two ways),
  // and RFC-0005 round 3 requires the pre-title row to be absent — not
  // merely `display: none` — below 768px. So the split is a real
  // conditional render keyed off a live `md`-breakpoint subscription.
  const isWide = useWideViewport();

  // feature-mobile-presence-card — `true` while the mobile presence
  // card's self-only collapse animation is in flight. Freezes
  // `useStickyHeader`'s compact threshold to the transition-start `H`
  // (below) so the animating slot's own reflow can't flip `compact`
  // mid-animation.
  const [cardTransitioning, setCardTransitioning] = useState(false);

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
  const { compact: scrolled } = useStickyHeader(expandedHeight, cardTransitioning);
  const compact = sticky && scrolled;

  // feature-mobile-presence-card — forceClose/focus-handoff contract:
  // when the header compacts, the (still-mounted, now `inert`) expanded
  // subtree's portaled overlays (LinkSharePopover, PageActionsMenu,
  // LivePresenceRow's desktop popover, expanded PageTocMenu, the mobile
  // card's own viewer Sheet) all force-close, and — if focus was inside
  // that subtree — it moves to the compact bar's scroll-to-top button
  // (the one control guaranteed to exist whenever `compact` is true)
  // BEFORE the placeholder's `inert` strands it. `inert` on an ancestor
  // does not itself relocate focus (only blurs it), so this is required,
  // not cosmetic.
  const scrollTopButtonRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!compact) return;
    const active = typeof document !== 'undefined' ? document.activeElement : null;
    if (active instanceof HTMLElement && measureRef.current?.contains(active)) {
      scrollTopButtonRef.current?.focus();
    }
    // Both refs are `useRef` objects with a stable identity, so `compact`
    // is the only dependency that can actually re-run this.
  }, [compact, measureRef]);

  // `presence` is supplied by the PageView (single hoisted `usePresence`
  // call → one shared `/presence` WebSocket for the expanded + compact
  // rows). Hosts that don't show presence (deleted page / user cover)
  // omit it; the `LivePresenceRow` / `MobilePresenceCard` gates below
  // narrow it before use.

  const isLiked = isAuthenticated && !!user && (page.liker ?? []).includes(user.id);
  // Separate "link-only" (RESTRICTED — anyone with the URL can view)
  // from "private" (SPECIFIED / OWNER — listed users only) so the
  // header reflects the actual sharing posture instead of collapsing
  // both into one Lock icon.
  const isLinkOnly = isLinkOnlyGrant(page.grant);
  const isPrivate = isPrivateGrant(page.grant);
  // Drafts (creator-only, unpublished) hide the social interactions
  // — like / watch / bookmark / link-share have no audience yet. The
  // dotmenu and edit button stay so the creator can still operate on
  // the draft.
  const isDraft = page.status === PageStatusEnum.DRAFT;
  const pageTitle = getPageTitle(page.path);

  // When a TOC rail is shown (≥1280, ≥2 entries), the article is part of
  // a centred `content + TOC` pair and sits 7.75rem left of dead-centre
  // in the [1280, 1440) band (see PageView). The compact header is a
  // `fixed inset-x-0` overlay that centres its own `max-w-4xl` content,
  // so without matching that shift its title would drift right of the
  // article in that band. Apply the same shift, gated to the same band +
  // TOC condition. At ≥1440 (spacer balances) and < 1280 (no rail) the
  // article is dead-centre, so no shift.
  const hasTocRail = toc.length >= 2;

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

  // Collapsed TOC button shown only below the right-rail breakpoint
  // (< 1280px). `compact` shrinks the trigger to fit the sticky bar's
  // 60px presence row. `PageTocMenu` itself no-ops for a sub-2-entry
  // TOC, but we gate here too so the wrapper span isn't emitted for
  // heading-light pages. `forceCloseMenu` force-closes an EXPANDED-subtree
  // instance when the header compacts (see the forceClose contract note
  // above) — omitted for the compact-bar instance, which remounts fresh
  // every time it appears and so never carries stale open state.
  const renderTocMenu = (compactSize: boolean, forceCloseMenu = false) =>
    toc.length >= 2 && (
      <span className="min-[1280px]:hidden">
        <PageTocMenu toc={toc} activeId={activeTocId} compact={compactSize} forceClose={forceCloseMenu} />
      </span>
    );
  // One expanded-subtree instance (its own `open` state) — it lands in
  // EITHER the wide presence+TOC row or the narrow TOC-only row, never
  // both: those two are mutually exclusive by `isWide` below, not by CSS.
  const tocMenuExpanded = renderTocMenu(false, compact);
  const tocMenuCompact = renderTocMenu(true);

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

        {/* Action group. Mobile renders `chip → like → edit → dotmenu`
            here (the title row is intentionally bare); md+ goes back to
            the icon-button toolbar (chip + edit live next to the title
            on md+, watch / bookmark / link surface as own buttons). */}
        <div className="flex items-center gap-2 md:gap-1 shrink-0 self-end md:self-auto">
          {page.grant != null && (
            <span className="md:hidden">
              <GrantChip grant={page.grant} />
            </span>
          )}
          {!isDraft && isAuthenticated && <LikeButton pageId={page._id} isLiked={isLiked} />}
          {!isDraft && isAuthenticated && (
            <span className="hidden md:inline-flex">
              <WatchButton pageId={page._id} />
            </span>
          )}
          {!isDraft && (
            <span className="hidden md:inline-flex">
              <BookmarkButton pageId={page._id} />
            </span>
          )}
          {!isDraft && (
            <span className="hidden md:inline-flex">
              <LinkSharePopover page={page} forceClose={compact} />
            </span>
          )}
          {editButton && <span className="md:hidden">{editButton}</span>}
          {showActions && (
            <>
              <span className="md:hidden">
                <PageActionsMenu page={page} compact isAuthenticated={isAuthenticated} forceClose={compact} />
              </span>
              <span className="hidden md:inline-flex">
                <PageActionsMenu page={page} isAuthenticated={isAuthenticated} forceClose={compact} />
              </span>
            </>
          )}
        </div>
      </div>

      {/* feature-mobile-presence-card — the pre-title presence/TOC row is
          now DESKTOP-ONLY, and gated in JS (`isWide`) rather than by
          `display`. RFC-0005 round 3 requires it to not be RENDERED below
          768px: the pre-fix code kept the row mounted on every viewport
          whenever `showPresence && isAuthenticated` and hid only its
          `LivePresenceRow` grandchild, so mobile still paid the row's
          reserved height + `space-y-5` rhythm margin with nobody else
          present. `hidden md:flex` would fix the pixels, but the row (and
          a `LivePresenceRow` that mobile never shows) would still mount,
          run effects and hold state — so the gate is a real conditional
          render, with the responsive classes kept as belt-and-braces for
          the single pre-hydration commit where `isWide` is still the SSR
          default. Mobile's live presence lives in `MobilePresenceCard`
          after `MetaChipRow` below; this row keeps ONLY the unchanged
          desktop avatar-strip + TOC pairing. */}
      {isWide
        ? ((showPresence && isAuthenticated) || tocMenuExpanded) && (
            <div className="hidden md:flex items-center gap-2" data-testid="presence-toc-row-desktop">
              <div className="min-w-0 flex-1">
                {showPresence && isAuthenticated && presence && <LivePresenceRow presence={presence} forceClose={compact} />}
              </div>
              {tocMenuExpanded}
            </div>
          )
        : /* Narrow viewports: no presence here at all. When the TOC menu
             is needed at this width it gets a row of its own, in the same
             "before the title" position. */
          tocMenuExpanded && (
            <div className="flex items-center justify-end md:hidden" data-testid="presence-toc-row-mobile">
              {tocMenuExpanded}
            </div>
          )}

      {showTitle ? (
        // Mobile stacks the chip + edit button onto their own row below
        // the title and right-aligns them so the title gets the full
        // width to wrap into; from `md` up everything sits on one row.
        <div className="flex flex-col gap-2 md:flex-row md:items-center md:gap-3">
          <h1 className="text-3xl md:text-[2.5rem] font-bold tracking-tight leading-[1.15] text-foreground md:flex-1 md:min-w-0">{pageTitle}</h1>
          {/* md+ only — mobile keeps the title row bare (chip + edit
              live next to the breadcrumb on mobile). */}
          <div className="hidden md:flex shrink-0 items-center justify-end gap-3 empty:hidden">
            {page.grant != null && <GrantChip grant={page.grant} />}
            {editButton}
          </div>
        </div>
      ) : (
        (isLinkOnly || isPrivate || onEdit) && (
          <div className="flex items-center justify-end gap-3">
            {page.grant != null && <GrantChip grant={page.grant} />}
            {editButton}
          </div>
        )
      )}

      {showMeta && <MetaChipRow page={page} />}

      {/* feature-mobile-presence-card — mobile-only live presence card,
          the mirror image of the `isWide` gate above: rendered only on
          narrow viewports, so its collapse animation / scroll
          compensation / sticky-threshold freeze never run on desktop
          (where the desktop strip owns presence and the AC requires the
          expanded header to be untouched). DOM order here is what the AC
          pins: title → author/updated → statistics chips → presence card
          → divider (rendered by the card itself, part of its own animated
          slot) → body content (owned by `PageView`, outside this
          component). */}
      {!isWide && showPresence && isAuthenticated && presence && (
        <MobilePresenceCard presence={presence} forceClose={compact} onTransitionStateChange={setCardTransitioning} />
      )}
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

        `inert` (feature-mobile-presence-card) removes the whole subtree
        from focus / tab order / hit-testing once compact — it coexists
        with the pre-existing `aria-hidden`, which only covers the
        accessibility tree (a sighted keyboard user could otherwise still
        Tab into an invisible expanded control without `inert`). It does
        NOT by itself close a still-open Portal-rendered overlay owned by
        this subtree (LinkSharePopover / PageActionsMenu / LivePresenceRow
        popover / expanded PageTocMenu / the mobile card's viewer Sheet all
        portal to `document.body`, outside this subtree) — that is what
        each owner's own `forceClose={compact}` prop above handles.
      */}
      <div ref={measureRef} data-testid="sticky-header-placeholder" aria-hidden={compact} inert={compact} className={cn(compact && 'invisible')}>
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
            'fixed inset-x-0 top-0 z-30 h-[60px] bg-background shadow-header dark:shadow-none dark:border-b dark:border-border',
            'transition-[opacity,transform] duration-150 ease-out motion-reduce:transition-none',
          )}
        >
          {/* Match the (auth) layout content width / gutters so the
              compact header lines up with the article column. The bar
              is a fixed 60px tall; the title row and the (shrunken)
              presence row are vertically centred inside it. */}
          <div
            className={cn('mx-auto flex h-full max-w-4xl flex-col justify-center gap-1 px-4', hasTocRail && 'min-[1280px]:max-[1439px]:-translate-x-[7.75rem]')}
          >
            <div className="flex items-center gap-2">
              {/* Scroll-to-top — sits to the left of the title, hanging
                  out past the content gutter (`-ml-9`). */}
              <button
                ref={scrollTopButtonRef}
                type="button"
                onClick={() => window.scrollTo({ top: 0, behavior: 'smooth' })}
                aria-label={m['page.scroll_to_top']()}
                className="-ml-9 shrink-0 rounded-full p-1.5 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                <ArrowUp className="h-4 w-4" />
              </button>
              <h1 className="text-base md:text-lg font-semibold tracking-tight text-foreground flex-1 min-w-0 truncate">{pageTitle}</h1>
              <div className="flex items-center gap-1 shrink-0">
                {!isDraft && isAuthenticated && <LikeButton pageId={page._id} isLiked={isLiked} iconOnly />}
                {editIconButton}
                {showActions && <PageActionsMenu page={page} compact isAuthenticated={isAuthenticated} />}
              </div>
            </div>
            {((showPresence && isAuthenticated) || tocMenuCompact) && (
              <div className="flex items-center gap-2">
                <div className="flex min-w-0 flex-1 items-center gap-2">
                  {/* One presence surface per viewport, same `isWide` gate
                      as the expanded header: desktop keeps the unchanged
                      compact avatar strip, mobile gets the short `Live · N`
                      / neutral trigger. Never both — the AC forbids
                      double-showing presence in the 60px bar. */}
                  {showPresence &&
                    isAuthenticated &&
                    presence &&
                    (isWide ? <LivePresenceRow presence={presence} size="compact" /> : <MobilePresenceCard presence={presence} variant="compact" />)}
                </div>
                {tocMenuCompact}
              </div>
            )}
          </div>
        </div>
      )}
    </header>
  );
}
