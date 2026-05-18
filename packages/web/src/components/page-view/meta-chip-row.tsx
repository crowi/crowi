'use client';

import { useState } from 'react';
import { Clock, Link2, MessageSquare, ThumbsUp, Eye } from 'lucide-react';
import type { PageWithRevision } from '@crowi/api-contract';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { TooltipProvider } from '@/components/ui/tooltip';
import { formatDistanceToNow } from '@/lib/date-utils';
import { useBacklinks } from '@/lib/use-backlinks';
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
 */
export function MetaChipRow({ page }: MetaChipRowProps) {
  const [likersOpen, setLikersOpen] = useState(false);
  const [seenOpen, setSeenOpen] = useState(false);

  const creator = typeof page.creator === 'object' && page.creator ? page.creator : null;
  const lastUpdateUser = typeof page.lastUpdateUser === 'object' && page.lastUpdateUser ? page.lastUpdateUser : null;
  const author = page.revision?.author ?? null;
  const displayUser = lastUpdateUser ?? creator ?? author;

  const likerCount = page.likerCount ?? page.liker?.length ?? 0;
  const seenUsersCount = page.seenUsersCount ?? 0;
  const commentCount = page.commentCount ?? 0;

  const { data: backlinkData } = useBacklinks(page._id, { limit: BACKLINK_COUNT_LIMIT });
  const backlinkCount = backlinkData?.backlinks.length ?? 0;

  return (
    <TooltipProvider>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2 text-sm text-muted-foreground">
        {displayUser && (
          <div className="flex items-center gap-2">
            <Avatar className="h-5 w-5">
              <AvatarImage src={displayUser.image || undefined} alt={displayUser.name} />
              <AvatarFallback className="bg-primary/10 text-primary text-[10px]">{displayUser.name.charAt(0).toUpperCase()}</AvatarFallback>
            </Avatar>
            <span className="text-foreground/80">{displayUser.name}</span>
          </div>
        )}

        {page.updatedAt && (
          <span className="inline-flex items-center gap-1">
            <Clock className="h-3.5 w-3.5" aria-hidden="true" />
            {m['page.meta_updated']({ time: formatDistanceToNow(page.updatedAt) })}
          </span>
        )}

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

      <LikersDialog pageId={page._id} open={likersOpen} onOpenChange={setLikersOpen} fallbackCount={likerCount} />
      <SeenUsersDialog pageId={page._id} open={seenOpen} onOpenChange={setSeenOpen} fallbackCount={seenUsersCount} />
    </TooltipProvider>
  );
}
