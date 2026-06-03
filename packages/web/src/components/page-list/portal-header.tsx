'use client';

import type { PageWithRevision } from '@crowi/api-contract';
import { m } from '@paraglide/messages.js';
import { Compass, Edit2 } from 'lucide-react';
import Link from 'next/link';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import { BookmarkButton } from '@/components/page-view/bookmark-button';
import { GrantChip } from '@/components/page-view/page-header';
import { PageActionsMenu } from '@/components/page-view/page-actions-menu';
import { formatAbsoluteDateTime, formatDistanceToNow } from '@/lib/date-utils';
import { resolveDisplayUser } from '@/lib/page-display-user';
import { useAuth } from '@/lib/use-auth';
import { usePageGrantAccent } from '@/lib/use-page-grant-accent';

interface PortalHeaderProps {
  page: PageWithRevision;
  onEdit: () => void;
}

/**
 * Portal context strip — a deliberately compact header that frames a
 * portal as "the entrance to a folder", not a content page.
 *
 * It is NOT the shared `PageHeader`: a portal has no place for the
 * social meta-chip row (0 いいね / 0 閲覧 / …) nor the full like / watch /
 * bookmark / link-share toolbar — those read as noise on a directory
 * landing. We also drop the big path-basename `<h1>` entirely so it no
 * longer competes with the portal document's own markdown `# heading`
 * (which is left to lead the body below as the single page title).
 *
 * What survives, in one quiet strip:
 *   - breadcrumb-overline ending in the current folder name + a PORTAL tag
 *   - minimal actions: bookmark (kept visible) + edit + a ⋯ menu that
 *     folds like / watch / copy-link in (RFC operators wanted them kept,
 *     just out of the way)
 *   - a single muted provenance line (updater + relative update time)
 */
export function PortalHeader({ page, onEdit }: PortalHeaderProps) {
  const { user, isAuthenticated } = useAuth();

  // Light the header accent strip for a non-public portal, exactly as the
  // single-page view does — a portal can be restricted/private too.
  usePageGrantAccent(page.grant);

  const isLiked = isAuthenticated && !!user && (page.liker ?? []).includes(user.id);

  const displayUser = resolveDisplayUser(page);
  const updaterUsername = displayUser && 'username' in displayUser ? displayUser.username : null;

  return (
    <TooltipProvider>
      <div className="border-b pb-4">
        {/* Row 1 — location overline + PORTAL tag (left) · actions (right) */}
        <div className="flex flex-wrap items-center gap-x-2 gap-y-2">
          <PortalOverline path={page.path} />
          <PortalTag />
          {/* Sharing posture (lock / link chip) for a non-public portal —
              restored from the shared page header so a restricted portal
              still signals it is not public. */}
          {page.grant != null && <GrantChip grant={page.grant} />}

          <div className="ml-auto flex shrink-0 items-center gap-1">
            {isAuthenticated && <BookmarkButton pageId={page._id} />}
            <Button variant="ghost" size="sm" onClick={onEdit} className="text-muted-foreground hover:text-foreground">
              <Edit2 className="mr-1 h-4 w-4" />
              {m['page.action_edit']()}
            </Button>
            <PageActionsMenu page={page} isAuthenticated={isAuthenticated} foldSocial isLiked={isLiked} />
          </div>
        </div>

        {/* Row 2 — single muted provenance line (no social chips) */}
        {displayUser && (
          <div className="mt-2.5 flex items-center gap-2 text-sm text-muted-foreground">
            <Avatar className="h-5 w-5">
              <AvatarImage src={displayUser.image || undefined} alt={displayUser.name} />
              <AvatarFallback className="bg-primary/10 text-[10px] text-primary">{displayUser.name.charAt(0).toUpperCase()}</AvatarFallback>
            </Avatar>
            {updaterUsername ? (
              <Link href={`/user/${updaterUsername}`} className="text-foreground/80 hover:text-foreground hover:underline">
                {displayUser.name}
              </Link>
            ) : (
              <span className="text-foreground/80">{displayUser.name}</span>
            )}
            {page.updatedAt && (
              <>
                <span aria-hidden className="text-border">
                  ·
                </span>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Link href={`/_history?path=${encodeURIComponent(page.path)}`} className="hover:text-foreground hover:underline">
                      {m['page.meta_updated']({ time: formatDistanceToNow(page.updatedAt) })}
                    </Link>
                  </TooltipTrigger>
                  <TooltipContent>{formatAbsoluteDateTime(page.updatedAt)}</TooltipContent>
                </Tooltip>
              </>
            )}
          </div>
        )}
      </div>
    </TooltipProvider>
  );
}

/**
 * Breadcrumb-style overline whose tail IS the current folder (bold, not a
 * link). The shared `<Breadcrumb>` drops the last segment because for a
 * normal page that segment is echoed by the `<h1>`; a portal has no such
 * H1, so here we keep the folder name visible — it's the only place the
 * location is named.
 */
/**
 * The small "PORTAL" pill (compass glyph + label) that sits at the end of
 * the overline. Shared by the live portal header and the no-document
 * fallback header so the two read as the same kind of surface.
 */
export function PortalTag() {
  return (
    <span className="inline-flex shrink-0 items-center gap-1 rounded-full border border-primary/20 bg-secondary px-2 py-0.5 text-[0.68rem] font-bold uppercase tracking-wider text-primary">
      <Compass className="h-3 w-3" aria-hidden="true" />
      {m['page_list.portal_label']()}
    </span>
  );
}

export function PortalOverline({ path }: { path: string }) {
  const crumbClass = 'transition-colors hover:text-foreground';

  if (path === '/') {
    return <span className="text-sm font-semibold text-foreground">Home</span>;
  }

  const segments = path.replace(/\/$/, '').split('/').filter(Boolean);
  const ancestors = segments.slice(0, -1).map((segment, index) => ({
    name: segment,
    href: `/${segments.slice(0, index + 1).join('/')}/`,
  }));
  const here = segments[segments.length - 1];

  return (
    <nav className="flex min-w-0 items-center gap-1 text-sm text-muted-foreground">
      <Link href="/" className={crumbClass}>
        Home
      </Link>
      {ancestors.map((item) => (
        <span key={item.href} className="flex items-center gap-1">
          <span className="text-border">/</span>
          <Link href={item.href} className={crumbClass}>
            {item.name}
          </Link>
        </span>
      ))}
      <span className="text-border">/</span>
      <span className="truncate font-semibold text-foreground">{here}</span>
    </nav>
  );
}
