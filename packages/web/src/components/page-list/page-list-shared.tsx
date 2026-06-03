'use client';

import type { Page } from '@crowi/api-contract';
import { m } from '@paraglide/messages.js';
import { List, Loader2, type LucideIcon } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { PageListItem, type PageListVariant } from './page-list-item';

/**
 * Shared building blocks for any "list of pages" surface — the main
 * `PageList`, user-profile / bookmarks / recent-create, and any future
 * page-listing view. Pulling these out keeps every list visually
 * identical (same Card padding rhythm, same skeleton, same section
 * header) so the layout reads as "the same kind of thing" everywhere
 * a page list appears.
 *
 * The shadcn `Card` default applies `flex flex-col gap-6 py-6` which
 * pads divide-y rows with dead vertical space; the `gap-0 py-0` overrides
 * collapse that so adjacent rows touch their dividers cleanly.
 */

interface PageRowsCardProps {
  pages: Page[];
  variant?: PageListVariant;
}

/**
 * Card-wrapped list of rows. The `divide-y` separates each `PageListItem`,
 * `overflow-hidden` clips the hover background to the rounded corners.
 */
export function PageRowsCard({ pages, variant = 'default' }: PageRowsCardProps) {
  return (
    <Card className="gap-0 divide-y overflow-hidden py-0">
      {pages.map((page) => (
        <PageListItem key={page._id} page={page} variant={variant} />
      ))}
    </Card>
  );
}

interface PageRowsSkeletonProps {
  rows?: number;
}

/**
 * Loading-state shimmer matching the 2-line row geometry. The default
 * row count covers a typical first-screen viewport so the post-fetch
 * layout shift stays modest even when the data response is larger than
 * the placeholder.
 *
 * Wrapped in `role="status"` so assistive tech announces the loading
 * state — the inner shimmer is `aria-hidden` because the bars carry no
 * semantic meaning and the role/aria-label pair already says "loading".
 */
export function PageRowsSkeleton({ rows = 15 }: PageRowsSkeletonProps) {
  return (
    <div role="status" aria-live="polite" aria-label={m['page_list.loading']()}>
      <Card className="gap-0 divide-y overflow-hidden py-0" aria-hidden>
        {Array.from({ length: rows }, (_, i) => `skeleton-${i}`).map((key) => (
          <div key={key} className="flex items-center gap-3 px-3 py-2.5">
            <div className="h-8 w-8 shrink-0 animate-pulse rounded-full bg-muted" />
            <div className="flex-1 space-y-1.5">
              <div className="h-4 w-1/3 animate-pulse rounded bg-muted" />
              <div className="h-3 w-1/2 animate-pulse rounded bg-muted" />
            </div>
          </div>
        ))}
      </Card>
    </div>
  );
}

interface PageListSectionHeaderProps {
  /** Icon shown before the label. Defaults to a generic `List` glyph. */
  icon?: LucideIcon;
  /** The header text. Callers format their own count (e.g. `{count} ページ`). */
  label: string;
  /** Optional slot rendered right next to the label (e.g. a create button). */
  labelAction?: React.ReactNode;
  /** Optional right-aligned slot (e.g. a sort control). */
  action?: React.ReactNode;
}

/**
 * The small muted row that sits above the `PageRowsCard` and tells the
 * reader what they are looking at (`23 件のページ`, `12 件のブックマーク`).
 * An optional `action` slot hugs the right edge for controls like sort.
 */
export function PageListSectionHeader({ icon: Icon = List, label, labelAction, action }: PageListSectionHeaderProps) {
  return (
    <div className="flex items-center gap-1.5 px-1 text-sm text-muted-foreground">
      <Icon className="h-4 w-4" />
      <span>{label}</span>
      {labelAction}
      {action && <div className="ml-auto">{action}</div>}
    </div>
  );
}

interface PageListEmptyCardProps {
  /** Optional large illustration glyph above the empty-state message. */
  icon?: LucideIcon;
  message: string;
}

/**
 * Card-shaped empty state, sized to mirror the rows-card so swapping
 * between "no pages" and "some pages" does not jolt the layout.
 */
export function PageListEmptyCard({ icon: Icon, message }: PageListEmptyCardProps) {
  // `gap-0` cancels shadcn Card's default flex gap (no inner stack to
  // space here), but `p-10` is preserved on both axes so the icon and
  // message keep breathing room from the card border.
  return (
    <Card className="gap-0 p-10 text-center">
      {Icon && <Icon className="mb-3 h-10 w-10 mx-auto text-muted-foreground/50" />}
      <p className="text-sm text-muted-foreground">{message}</p>
    </Card>
  );
}

interface LoadMoreButtonProps {
  onClick: () => void;
  isLoading?: boolean;
}

/**
 * "さらに読み込む" pager for infinite-query backed lists (user pages /
 * bookmarks). The main page list uses offset pagination instead — see
 * `Pagination` — so this primitive is intentionally scoped to load-more
 * flows. i18n strings live under `page_list.*` so the button stays
 * reusable from any future "list of pages" surface.
 */
export function LoadMoreButton({ onClick, isLoading = false }: LoadMoreButtonProps) {
  return (
    <div className="text-center">
      <Button variant="outline" onClick={onClick} disabled={isLoading}>
        {isLoading ? (
          <>
            <Loader2 className="h-4 w-4 animate-spin mr-2" />
            {m['page_list.loading_more']()}
          </>
        ) : (
          m['page_list.load_more']()
        )}
      </Button>
    </div>
  );
}
