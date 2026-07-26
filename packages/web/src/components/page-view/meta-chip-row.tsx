'use client';

import Link from 'next/link';
import { Clock, Link2, MessageSquare, ThumbsUp, Eye } from 'lucide-react';
import type { PageWithRevision } from '@crowi/api-contract';
import { PageDisplayUserBadge } from '@/components/page-display-user-badge';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import { formatAbsoluteDateTime, formatDistanceToNow } from '@/lib/date-utils';
import { resolveDisplayUser } from '@/lib/page-display-user';
import { useBacklinks } from '@/lib/use-backlinks';
import { useForceCloseable } from '@/lib/use-force-closeable';
import { SCROLL_TARGETS, scrollToSection } from '@/lib/scroll-to-section';
import { m } from '@paraglide/messages.js';
import { MetaChip } from './meta-chip';
import { LikersDialog } from './likers-dialog';
import { SeenUsersDialog } from './seen-user-list';

// Backlink count source: the same fetch the footer `BacklinkList` uses,
// but with a higher cap so the chip count reflects the real total for
// typical pages. `hasNext` past this cap is rare enough to accept.
const BACKLINK_COUNT_LIMIT = 50;

interface MetaChipRowProps {
  page: PageWithRevision;
  /**
   * feature-mobile-presence-card — force-closes the likers/seen-by
   * Dialogs while `true`. `PageHeader` sets it from its own `compact`
   * sticky state; see `useForceCloseable` for why a Portal-rendered
   * overlay needs this even though its trigger's ancestor already goes
   * `inert`.
   */
  forceClose?: boolean;
}

/**
 * RFC-0005 Phase 3 — the restructured page meta row.
 *
 * Two static elements at the start (author avatar/name + last-updated
 * time), then four uniform `[icon][count][label]` chips:
 *
 *   - いいね  → opens the "Liked by" modal
 *   - 閲覧    → opens the existing "Seen by" modal
 *   - コメント → smooth-scrolls to the comments section
 *   - バックリンク → smooth-scrolls to the footer backlink list
 *
 * Zero-count chips render greyed + non-interactive with a tooltip
 * (handled inside `MetaChip`).
 *
 * feature-mobile-presence-card split this into two DOM groups (author/
 * updated meta vs. the 4 stat chips) so mobile can stack them (each
 * group its own row). At `md`+ the groups collapse to `display: contents`
 * so the outer row is *by construction* the original single wrapping flex
 * row with the same six direct flex items — `MetaChip` itself and the 4
 * chips' data / dialog / scroll / zero-count behaviour are untouched.
 */
export function MetaChipRow({ page, forceClose = false }: MetaChipRowProps) {
  const [likersOpen, setLikersOpen] = useForceCloseable(forceClose);
  const [seenOpen, setSeenOpen] = useForceCloseable(forceClose);

  const displayUser = resolveDisplayUser(page);

  const likerCount = page.likerCount ?? page.liker?.length ?? 0;
  const seenUsersCount = page.seenUsersCount ?? 0;
  const commentCount = page.commentCount ?? 0;

  const { data: backlinkData } = useBacklinks(page._id, { limit: BACKLINK_COUNT_LIMIT });
  const backlinkCount = backlinkData?.backlinks.length ?? 0;

  return (
    <TooltipProvider>
      {/* Two DOM groups (feature-mobile-presence-card): author/updated meta
          vs. the 4 stat chips. Mobile stacks them (each its own row).
          At `md`+ both groups are `display: contents`, so they generate no
          box and their children are again the six direct flex items of the
          outer row — whose `md`+ computed style (`flex-row` + `flex-wrap` +
          `items-center` + `gap-x-3` + `gap-y-2`) is the pre-split container.
          The `md`+ layout is therefore identical by construction, including
          where the row wraps, so the header height / sticky threshold / TOC
          alignment cannot drift. Do not replace `md:contents` with a
          flex-group approximation. */}
      <div className="flex flex-col gap-x-3 gap-y-2 md:flex-row md:flex-wrap md:items-center text-sm text-muted-foreground">
        {(displayUser || page.updatedAt) && (
          <div data-testid="meta-chip-group-meta" className="flex flex-wrap items-center gap-x-3 gap-y-2 md:contents">
            {displayUser && (
              <div className="flex items-center gap-2">
                <PageDisplayUserBadge user={displayUser} />
              </div>
            )}

            {page.updatedAt && (
              <Tooltip>
                <TooltipTrigger asChild>
                  <Link
                    href={`/_history?path=${encodeURIComponent(page.path)}`}
                    className="inline-flex items-center gap-1 hover:text-foreground hover:underline"
                  >
                    <Clock className="h-3.5 w-3.5" aria-hidden="true" />
                    {m['page.meta_updated']({ time: formatDistanceToNow(page.updatedAt) })}
                  </Link>
                </TooltipTrigger>
                <TooltipContent>{formatAbsoluteDateTime(page.updatedAt)}</TooltipContent>
              </Tooltip>
            )}
          </div>
        )}

        <div data-testid="meta-chip-group-stats" className="flex flex-wrap items-center gap-x-3 gap-y-2 md:contents">
          <MetaChip
            icon={ThumbsUp}
            count={likerCount}
            label={m['page.like_label']()}
            emptyTooltip={m['page.meta_likes_empty']()}
            ariaLabel={m['page.meta_likes_aria']({ count: likerCount })}
            onClick={() => setLikersOpen(true)}
          />
          <MetaChip
            icon={Eye}
            count={seenUsersCount}
            label={m['page.seen_by']()}
            emptyTooltip={m['page.meta_views_empty']()}
            ariaLabel={m['page.meta_views_aria']({ count: seenUsersCount })}
            onClick={() => setSeenOpen(true)}
          />
          <MetaChip
            icon={MessageSquare}
            count={commentCount}
            label={m['page.meta_comments_label']()}
            emptyTooltip={m['page.meta_comments_empty']()}
            ariaLabel={m['page.meta_comments_aria']({ count: commentCount })}
            onClick={() => scrollToSection(SCROLL_TARGETS.COMMENTS)}
          />
          <MetaChip
            icon={Link2}
            count={backlinkCount}
            label={m['page.meta_backlinks_label']()}
            emptyTooltip={m['page.meta_backlinks_empty']()}
            ariaLabel={m['page.meta_backlinks_aria']({ count: backlinkCount })}
            onClick={() => scrollToSection(SCROLL_TARGETS.BACKLINKS)}
          />
        </div>
      </div>

      <LikersDialog pageId={page._id} open={likersOpen} onOpenChange={setLikersOpen} fallbackCount={likerCount} />
      <SeenUsersDialog pageId={page._id} open={seenOpen} onOpenChange={setSeenOpen} fallbackCount={seenUsersCount} />
    </TooltipProvider>
  );
}
