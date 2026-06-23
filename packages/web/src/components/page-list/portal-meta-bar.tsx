'use client';

import type { PageWithRevision } from '@crowi/api-contract';
import { m } from '@paraglide/messages.js';
import { Link2, MessageSquare, Paperclip } from 'lucide-react';
import { useState } from 'react';
import { AttachmentList } from '@/components/page-view/attachment-list';
import { BacklinkList } from '@/components/page-view/backlink-list';
import { PageComments } from '@/components/page-comments';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { useAttachmentList } from '@/lib/use-attachments';
import { useBacklinks } from '@/lib/use-backlinks';
import { usePageCommentsList } from '@/lib/use-page-comments';

// Peek the backlinks at the same limit `BacklinkList` opens with, so the
// count chip shares its react-query cache entry (no extra request). The
// count is capped at this limit; `hasMore` turns it into "N+".
const BACKLINK_PEEK_LIMIT = 5;

type PortalMetaKey = 'comments' | 'backlinks' | 'attachments';

interface PortalMetaCounts {
  commentCount: number;
  backlinkCount: number;
  backlinkHasMore: boolean;
  attachmentCount: number;
}

export interface PortalMetaChip {
  key: PortalMetaKey;
  /** Display count; null when the chip carries no number (none yet). */
  count: number | null;
  /** Append a "+" — the true count exceeds the peeked `count`. */
  more: boolean;
}

/**
 * Decide which compact chips a portal's meta bar shows, in display order.
 *
 * - comments: ALWAYS shown (you can post the first one even at 0).
 * - backlinks / attachments: shown ONLY when non-empty — there is nothing to
 *   add from here, so a "0" chip would be noise.
 *
 * Pure so the selection rules are unit-tested without rendering.
 */
export function buildPortalMetaChips(counts: PortalMetaCounts): PortalMetaChip[] {
  const chips: PortalMetaChip[] = [{ key: 'comments', count: counts.commentCount, more: false }];
  if (counts.backlinkCount > 0) {
    chips.push({ key: 'backlinks', count: counts.backlinkCount, more: counts.backlinkHasMore });
  }
  if (counts.attachmentCount > 0) {
    chips.push({ key: 'attachments', count: counts.attachmentCount, more: false });
  }
  return chips;
}

const CHIP_ICON: Record<PortalMetaKey, typeof MessageSquare> = {
  comments: MessageSquare,
  backlinks: Link2,
  attachments: Paperclip,
};

function chipLabel(key: PortalMetaKey): string {
  if (key === 'comments') return m['portal_meta.comments']();
  if (key === 'backlinks') return m['portal_meta.backlinks']();
  return m['portal_meta.attachments']();
}

/**
 * Compact "page meta" bar for a portal — a single row of toggle chips
 * (comments / backlinks / attachments) sitting between the portal body and
 * the child-page list. Each chip toggles an inline panel rendering the same
 * component a normal page uses, so the portal keeps these affordances without
 * the full stacked sections competing with the (often long) child list.
 *
 * The count queries share their cache keys with the panels they expand into
 * (and with the normal page view), so showing the bar costs no extra request
 * beyond what a page already fetches.
 */
export function PortalMetaBar({ page }: { page: PageWithRevision }) {
  const pageId = page._id;
  const { comments } = usePageCommentsList(pageId);
  const { data: attachmentData } = useAttachmentList(pageId);
  const { data: backlinkData } = useBacklinks(pageId, { limit: BACKLINK_PEEK_LIMIT });

  const chips = buildPortalMetaChips({
    commentCount: comments.length,
    backlinkCount: backlinkData?.backlinks.length ?? 0,
    backlinkHasMore: backlinkData?.hasNext ?? false,
    attachmentCount: attachmentData?.attachments.length ?? 0,
  });

  const [open, setOpen] = useState<Set<PortalMetaKey>>(() => new Set());
  const toggle = (key: PortalMetaKey) => {
    setOpen((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  return (
    <section aria-label={m['portal_meta.aria']()} className="space-y-3">
      <div className="flex flex-wrap items-center gap-1.5">
        {chips.map((chip) => {
          const Icon = CHIP_ICON[chip.key];
          const isOpen = open.has(chip.key);
          return (
            <Button
              key={chip.key}
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => toggle(chip.key)}
              aria-expanded={isOpen}
              className={cn(
                'h-7 gap-1.5 rounded-full border px-2.5 text-xs',
                isOpen ? 'border-border bg-muted text-foreground' : 'border-transparent text-muted-foreground hover:text-foreground',
              )}
            >
              <Icon className="h-3.5 w-3.5" aria-hidden />
              <span>{chipLabel(chip.key)}</span>
              {chip.count !== null && chip.count > 0 && (
                <span className="font-medium text-foreground">
                  {chip.count}
                  {chip.more ? '+' : ''}
                </span>
              )}
            </Button>
          );
        })}
      </div>

      {/* Expanded panels render the exact components a normal page uses. */}
      {open.has('comments') && <PageComments page={page} />}
      {open.has('backlinks') && <BacklinkList pageId={pageId} />}
      {open.has('attachments') && <AttachmentList pageId={pageId} />}
    </section>
  );
}
