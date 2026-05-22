import { z } from '@hono/zod-openapi';

/**
 * Numbered pager shape for admin list views. Mirrors the legacy
 * `createPager` helper (packages/api/src/controllers/admin.ts:22-93)
 * so the wire format is forward-compatible across the migration.
 *
 * Distinct from `PagerSchema` (schemas/page.ts), which is the
 * offset/prev/next bundle used by infinite-scroll lists. This one is
 * the windowed numeric pager (1..N + "..." dots) suited to a tabular
 * admin list.
 *
 * Fields:
 * - page          : 1-based current page index.
 * - pagesCount    : Total number of pages (= ceil(total / limit), or 0
 *                   when total is 0 — mongoose-paginate emits 0).
 * - pages         : Page numbers to render as buttons (windowed around
 *                   `page`, max length = MAX_PAGE_LIST in the helper).
 * - total         : Total number of matching documents.
 * - previous      : Previous page number, or null on the first page.
 * - previousDots  : Whether to render a "..." between the first page
 *                   button and the windowed range.
 * - next          : Next page number, or null on the last page.
 * - nextDots      : Symmetric to `previousDots` on the right side.
 */
export const AdminPagerSchema = z.object({
  page: z.number(),
  pagesCount: z.number(),
  pages: z.array(z.number()),
  total: z.number(),
  previous: z.number().nullable(),
  previousDots: z.boolean(),
  next: z.number().nullable(),
  nextDots: z.boolean(),
});
export type AdminPager = z.infer<typeof AdminPagerSchema>;
