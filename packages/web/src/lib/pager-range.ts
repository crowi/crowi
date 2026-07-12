/**
 * Shared page-range computation for numbered pagers (`<Pager mode="numbered">`,
 * `components/ui/pager.tsx`).
 *
 * Moved out of `search-pager.tsx` (feature-unified-pager) so search results,
 * the admin user list, and any future numbered pager compute the exact same
 * windowed range + "..." dots decision instead of each maintaining its own
 * copy — `users-table.tsx`'s `AdminPager` used to have the server precompute
 * the same window server-side; that duplication now converges on this single
 * client-side implementation (see spec's "実装方針").
 */

/** Page numbers to render as number buttons, windowed +/- `span` around `current`. */
export function buildPageRange(current: number, totalPages: number, span = 2): number[] {
  const start = Math.max(1, current - span);
  const end = Math.min(totalPages, current + span);
  const out: number[] = [];
  for (let i = start; i <= end; i += 1) out.push(i);
  return out;
}

export interface PagerWindow {
  /** Page numbers to render as number buttons. */
  pages: number[];
  /** Whether to render a leading "1 …" affordance before `pages`. */
  showLeftDots: boolean;
  /** Whether to render a trailing "… totalPages" affordance after `pages`. */
  showRightDots: boolean;
}

/** `buildPageRange` plus the leading/trailing "..." dots decision (former search-pager.tsx:33-34). */
export function computePagerWindow(current: number, totalPages: number, span = 2): PagerWindow {
  const pages = buildPageRange(current, totalPages, span);
  // No `pages.length > 0 &&` guard needed: on an empty range, `pages[0]` /
  // `pages[pages.length - 1]` are `undefined`, and any `undefined`
  // comparison is `false`, matching the intended "empty range on either
  // side, so no dots" result.
  const showLeftDots = pages[0] > 1;
  const showRightDots = pages[pages.length - 1] < totalPages;
  return { pages, showLeftDots, showRightDots };
}
