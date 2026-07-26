'use client';

import { Eye, Pencil } from 'lucide-react';
import type { PresenceViewer } from '@crowi/api-contract';
import { UserAvatar } from '@/components/user-avatar';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { useForceCloseable } from '@/lib/use-force-closeable';
import type { UsePresenceResult } from '@/lib/use-presence';
import { cn } from '@/lib/utils';
import { m } from '@paraglide/messages.js';

/**
 * RFC-0005 §"Live presence row" — the avatar strip above the page
 * title showing who is *currently* viewing the page.
 *
 * `md`+ (desktop) behaviour, unchanged by feature-mobile-presence-card:
 *   - up to {@link MAX_VISIBLE_AVATARS} avatars inline, surplus folds
 *     into a `[+N]` button that opens a popover with every viewer;
 *   - viewers who also have the editor open get a ✏️ corner badge;
 *   - the current user appears in their own stack (Google Docs model)
 *     and is labelled "(you)" in the popover;
 *   - the row *content* is hidden when the only viewer is the current
 *     user — no value in showing yourself alone (RFC open question 2);
 *   - if the presence WebSocket never connects the row content is
 *     hidden (graceful fallback — `usePresence` reports `status:
 *     'error'`);
 *   - the row reserves a fixed height even when its content is hidden,
 *     so a viewer joining / leaving never shifts the page layout.
 *
 * Below `md` this row renders NOTHING (`hidden md:flex`) — the mobile
 * live-presence UI moved to its own `MobilePresenceCard` (default
 * variant placed after `MetaChipRow`, compact variant inside the sticky
 * bar), which needed a different DOM position and a richer state model
 * (self-only collapse, reconnect semantics) than this row's fixed-height
 * reservation model supports. See `mobile-presence-card.tsx`.
 */

/** Inline avatars before overflow folds into `[+N]`. */
const MAX_VISIBLE_AVATARS = 5;

/** Popover / sheet viewer-list cap (RFC open question 3). */
const VIEWER_LIST_CAP = 20;

interface LivePresenceRowProps {
  /**
   * The result of `usePresence(pageId)`. The hook is hoisted to the
   * parent so the expanded and compact (sticky) variants of this row
   * share ONE WebSocket — otherwise compact-mount would open a second
   * connection and the viewer list would lag 2-3s behind the expanded
   * row every time the header sticks.
   */
  presence: UsePresenceResult;
  /**
   * `compact` shrinks the row for the sticky / scrolled page header:
   * the "閲覧中" label is dropped and the row height is tightened. The
   * fixed-height / no-layout-shift guarantee (RFC-0005) holds in both
   * sizes — only the reserved height differs.
   */
  size?: 'default' | 'compact';
  /**
   * feature-mobile-presence-card — force-closes the desktop overflow
   * `[+N]` popover while `true`; see `useForceCloseable` for why a
   * Portal-rendered overlay needs this even though its trigger's ancestor
   * already goes `inert`. `PageHeader` sets it from its own `compact`
   * sticky state for the row instance inside the EXPANDED subtree, and
   * omits it for the row's OTHER instance — the one mounted fresh inside
   * the compact bar itself, which (re)mounts every time the bar appears
   * and so never carries stale open state.
   */
  forceClose?: boolean;
}

export function LivePresenceRow({ presence, size = 'default', forceClose = false }: LivePresenceRowProps) {
  const { viewers, selfUserId, status } = presence;
  const isCompact = size === 'compact';

  // Show content only when the presence channel is up and someone
  // besides the current user is here (no value in showing yourself
  // alone; an errored WS degrades gracefully). The wrapper below always
  // renders with a fixed min-height (on `md`+, where this row is
  // actually laid out — see `hidden md:flex` on the root), so reserving
  // the row's vertical space is independent of whether there is content
  // to show — content appearing or disappearing never shifts the page
  // layout.
  const hasOthers = status !== 'error' && viewers.some((v) => v.userId !== selfUserId);

  return (
    <div
      className={cn('hidden md:flex items-center gap-2', isCompact ? 'min-h-6 md:min-h-5' : 'min-h-7 md:min-h-6')}
      data-testid="live-presence-row"
      data-size={size}
    >
      {hasOthers && (
        <>
          {!isCompact && (
            <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
              <Eye className="h-3.5 w-3.5" aria-hidden="true" />
              {m['page.presence_label']()}
            </span>
          )}
          <PresenceAvatarStack viewers={viewers} selfUserId={selfUserId} forceClose={forceClose} />
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
function PresenceAvatarStack({ viewers, selfUserId, forceClose }: ViewerListProps & { forceClose: boolean }) {
  const [open, setOpen] = useForceCloseable(forceClose);
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

/**
 * Avatar + optional ✏️ editing corner badge, visual only (no tooltip, no
 * accessible name of its own). Shared by the desktop interactive
 * `PresenceAvatar` below (which wraps this in a `Tooltip`) and
 * `MobilePresenceCard`'s non-interactive, `aria-hidden` avatar stack
 * (`mobile-presence-card.tsx`) — extracted so the mobile card reuses the
 * exact same avatar rendering instead of re-implementing it.
 */
export function PresenceAvatarVisual({ viewer }: { viewer: PresenceViewer }) {
  return (
    <span className="relative inline-block">
      <UserAvatar user={{ name: viewer.displayName, username: viewer.username, image: viewer.avatarUrl }} size="sm" />
      {viewer.isEditing && (
        <span
          role="img"
          className="absolute -bottom-0.5 -right-0.5 flex h-3 w-3 items-center justify-center rounded-full bg-primary ring-1 ring-background"
          aria-label={m['page.presence_editing_badge']({ name: viewer.displayName || viewer.username })}
        >
          <Pencil className="h-2 w-2 text-primary-foreground" aria-hidden="true" />
        </span>
      )}
    </span>
  );
}

/** A single avatar with optional ✏️ editing corner badge. */
function PresenceAvatar({ viewer, isSelf }: { viewer: PresenceViewer; isSelf: boolean }) {
  const displayName = viewer.displayName || viewer.username;
  const tooltip = isSelf ? `${displayName} ${m['page.presence_you']()}` : displayName;

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <PresenceAvatarVisual viewer={viewer} />
      </TooltipTrigger>
      <TooltipContent>{viewer.isEditing ? `${tooltip} · ${m['page.presence_editing']()}` : tooltip}</TooltipContent>
    </Tooltip>
  );
}

/**
 * Full viewer list rendered inside the desktop popover and
 * `MobilePresenceCard`'s viewer sheet (`mobile-presence-card.tsx`).
 * Exported for the latter — the mobile card reuses this verbatim rather
 * than re-implementing viewer-row rendering.
 */
export function PresenceViewerList({ viewers, selfUserId, titleId }: ViewerListProps & { titleId?: string }) {
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
