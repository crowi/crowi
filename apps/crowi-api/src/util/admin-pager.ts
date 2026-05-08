import type { AdminPager } from '@crowi/api-contract';

/**
 * Maximum number of numbered page buttons rendered around the current page.
 * Mirrors the legacy `MAX_PAGE_LIST = 5` in the admin controller (legacy
 * `apps/crowi-api/src/controllers/admin.ts:16`).
 */
export const MAX_PAGE_LIST = 5;

/**
 * Build a pager bundle compatible with the legacy `createPager` helper
 * (apps/crowi-api/src/controllers/admin.ts:22-93). The wire format is kept
 * identical so the new admin UI can consume the same numbered pager + dots
 * without translation, and the helper is shared across every admin list
 * view that needs paging (users, groups, attachments, ...).
 *
 * Notes:
 * - `pagesCount` may be 0 when there are no matching documents; the
 *   windowing loop correctly emits an empty `pages` array in that case
 *   (pagerMin collapses to 1 and pagerMax stays at 0, so the for-loop
 *   body never runs).
 * - The windowing has a 1-off carryover from the legacy implementation
 *   (`pagerMin = pagerMax - MAX_PAGE_LIST` at the right edge can produce
 *   6 buttons instead of 5). Preserved verbatim for parity.
 */
export function createPager(total: number, page: number, pagesCount: number, maxPageList: number = MAX_PAGE_LIST): AdminPager {
  const pager: AdminPager = {
    page,
    pagesCount,
    pages: [],
    total,
    previous: null,
    previousDots: false,
    next: null,
    nextDots: false,
  };

  if (page > 1) {
    pager.previous = page - 1;
  }

  if (page < pagesCount) {
    pager.next = page + 1;
  }

  let pagerMin = Math.max(1, Math.ceil(page - maxPageList / 2));
  let pagerMax = Math.min(pagesCount, Math.floor(page + maxPageList / 2));
  if (pagerMin === 1) {
    if (maxPageList < pagesCount) {
      pagerMax = maxPageList;
    } else {
      pagerMax = pagesCount;
    }
  }
  if (pagerMax === pagesCount) {
    if (pagerMax - maxPageList < 1) {
      pagerMin = 1;
    } else {
      pagerMin = pagerMax - maxPageList;
    }
  }

  if (pagerMin > 1) {
    pager.previousDots = true;
  }

  if (pagerMax < pagesCount) {
    pager.nextDots = true;
  }

  for (let i = pagerMin; i <= pagerMax; i++) {
    pager.pages.push(i);
  }

  return pager;
}
