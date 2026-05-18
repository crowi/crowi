'use client';

import { useState } from 'react';
import { Eye, Pencil } from 'lucide-react';
import type { PresenceViewer } from '@crowi/api-contract';
import { UserAvatar } from '@/components/user-avatar';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetTrigger } from '@/components/ui/sheet';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { usePresence } from '@/lib/use-presence';
import { cn } from '@/lib/utils';
import { m } from '@paraglide/messages.js';

/**
 * RFC-0005 §"Live presence row" — the avatar strip above the page
 * title showing who is *currently* viewing the page.
 *
 * Behaviour:
 *   - up to {@link MAX_VISIBLE_AVATARS} avatars inline, surplus folds
 *     into a `[+N]` button that opens a popover with every viewer;
 *   - viewers who also have the editor open get a ✏️ corner badge;
 *   - the current user appears in their own stack (Google Docs model)
 *     and is labelled "(you)" in the popover / sheet;
 *   - the row *content* is hidden when the only viewer is the current
 *     user — no value in showing yourself alone (RFC open question 2);
 *   - on narrow viewports (< 768px) the row collapses to a single
 *     `[👁 N]` chip that taps open a sheet listing all viewers;
 *   - if the presence WebSocket never connects the row content is
 *     hidden (graceful fallback — `usePresence` reports `status:
 *     'error'`);
 *   - the row reserves a fixed height even when its content is hidden,
 *     so a viewer joining / leaving never shifts the page layout.
 */

/** Inline avatars before overflow folds into `[+N]`. */
const MAX_VISIBLE_AVATARS = 5;

/** Popover / sheet viewer-list cap (RFC open question 3). */
const VIEWER_LIST_CAP = 20;

interface LivePresenceRowProps {
  pageId: string;
}

export function LivePresenceRow({ pageId }: LivePresenceRowProps) {
  const { viewers, selfUserId, status } = usePresence(pageId);

  // Show content only when the presence channel is up and someone
  // besides the current user is here (no value in showing yourself
  // alone; an errored WS degrades gracefully). The wrapper below always
  // renders with a fixed min-height, so reserving the row's vertical
  // space is independent of whether there is content to show — content
  // appearing or disappearing never shifts the page layout.
  const hasOthers = status !== 'error' && viewers.some((v) => v.userId !== selfUserId);

  return (
    <div className="flex items-center gap-2 min-h-7 md:min-h-6" data-testid="live-presence-row">
      {hasOthers && (
        <>
          {/* Desktop / wide: label + avatar stack. */}
          <div className="hidden md:flex items-center gap-2">
            <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
              <Eye className="h-3.5 w-3.5" aria-hidden="true" />
              {m['page.presence_label']()}
            </span>
            <PresenceAvatarStack viewers={viewers} selfUserId={selfUserId} />
          </div>

          {/* Narrow: collapsed [👁 N] chip → sheet. */}
          <div className="md:hidden">
            <PresenceMobileChip viewers={viewers} selfUserId={selfUserId} />
          </div>
        </>
      )}
    </div>
  );
}

interface ViewerListProps {
  viewers: PresenceViewer[];
  selfUserId: string | null;
}

/** Wide-viewport avatar stack with `[+N]` overflow popover. */
function PresenceAvatarStack({ viewers, selfUserId }: ViewerListProps) {
  const [open, setOpen] = useState(false);
  const visible = viewers.slice(0, MAX_VISIBLE_AVATARS);
  const overflowCount = viewers.length - visible.length;

  return (
    <div className="flex items-center gap-1.5">
      <ul className="flex items-center -space-x-2" aria-label={m['page.presence_label']()}>
        {visible.map((viewer) => (
          <li key={viewer.userId} className="rounded-full ring-2 ring-background">
            <PresenceAvatar viewer={viewer} isSelf={viewer.userId === selfUserId} />
          </li>
        ))}
      </ul>
      {overflowCount > 0 && (
        <Popover open={open} onOpenChange={setOpen}>
          <PopoverTrigger
            className="inline-flex h-6 items-center rounded-full bg-muted px-2 text-xs font-medium text-muted-foreground transition-colors hover:bg-muted/70"
            aria-label={m['page.presence_more']({ count: overflowCount })}
          >
            +{overflowCount}
          </PopoverTrigger>
          <PopoverContent align="start" className="w-64 p-0">
            <PresenceViewerList viewers={viewers} selfUserId={selfUserId} titleId="presence-popover-title" />
          </PopoverContent>
        </Popover>
      )}
    </div>
  );
}

/** Narrow-viewport `[👁 N]` chip that taps open a viewer-list sheet. */
function PresenceMobileChip({ viewers, selfUserId }: ViewerListProps) {
  return (
    <Sheet>
      <SheetTrigger
        className="inline-flex h-7 items-center gap-1.5 rounded-full bg-muted px-2.5 text-xs font-medium text-muted-foreground transition-colors hover:bg-muted/70"
        aria-label={m['page.presence_count']({ count: viewers.length })}
      >
        <Eye className="h-3.5 w-3.5" aria-hidden="true" />
        {viewers.length}
      </SheetTrigger>
      {/* No SheetDescription — the title alone names the sheet; opt out
          of Radix's describedby warning explicitly. */}
      <SheetContent side="bottom" aria-describedby={undefined}>
        <SheetHeader>
          <SheetTitle>{m['page.presence_sheet_title']()}</SheetTitle>
        </SheetHeader>
        <div className="max-h-[60vh] overflow-y-auto">
          <PresenceViewerList viewers={viewers} selfUserId={selfUserId} />
        </div>
      </SheetContent>
    </Sheet>
  );
}

/** A single avatar with optional ✏️ editing corner badge. */
function PresenceAvatar({ viewer, isSelf }: { viewer: PresenceViewer; isSelf: boolean }) {
  const displayName = viewer.displayName || viewer.username;
  const tooltip = isSelf ? `${displayName} ${m['page.presence_you']()}` : displayName;

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span className="relative inline-block">
          <UserAvatar user={{ name: viewer.displayName, username: viewer.username, image: viewer.avatarUrl }} size="sm" />
          {viewer.isEditing && (
            <span
              role="img"
              className="absolute -bottom-0.5 -right-0.5 flex h-3 w-3 items-center justify-center rounded-full bg-primary ring-1 ring-background"
              aria-label={m['page.presence_editing_badge']({ name: displayName })}
            >
              <Pencil className="h-2 w-2 text-primary-foreground" aria-hidden="true" />
            </span>
          )}
        </span>
      </TooltipTrigger>
      <TooltipContent>{viewer.isEditing ? `${tooltip} · ${m['page.presence_editing']()}` : tooltip}</TooltipContent>
    </Tooltip>
  );
}

/** Full viewer list rendered inside the popover and the mobile sheet. */
function PresenceViewerList({ viewers, selfUserId, titleId }: ViewerListProps & { titleId?: string }) {
  const capped = viewers.slice(0, VIEWER_LIST_CAP);
  const overflowCount = viewers.length - capped.length;

  return (
    <div className="py-1">
      {titleId && (
        <p id={titleId} className="px-3 py-2 text-xs font-medium text-muted-foreground">
          {m['page.presence_popover_title']()}
        </p>
      )}
      <ul className="max-h-72 overflow-y-auto" aria-labelledby={titleId}>
        {capped.map((viewer) => {
          const isSelf = viewer.userId === selfUserId;
          const displayName = viewer.displayName || viewer.username;
          return (
            <li key={viewer.userId} className="flex items-center gap-2.5 px-3 py-1.5">
              <PresenceAvatar viewer={viewer} isSelf={isSelf} />
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-1 text-sm">
                  <span className="truncate font-medium">{displayName}</span>
                  {isSelf && <span className="shrink-0 text-xs text-muted-foreground">{m['page.presence_you']()}</span>}
                </div>
                <div className="truncate text-xs text-muted-foreground">@{viewer.username}</div>
              </div>
              {viewer.isEditing && (
                <span className={cn('inline-flex shrink-0 items-center gap-1 text-xs text-primary')}>
                  <Pencil className="h-3 w-3" aria-hidden="true" />
                  {m['page.presence_editing']()}
                </span>
              )}
            </li>
          );
        })}
      </ul>
      {overflowCount > 0 && <p className="px-3 py-2 text-xs text-muted-foreground">{m['page.presence_overflow']({ count: overflowCount })}</p>}
    </div>
  );
}
