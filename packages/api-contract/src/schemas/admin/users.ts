import { z } from 'zod';
import { UserPublicSchema } from '../userPublic';

/**
 * Pager shape for the legacy admin user list. The legacy `createPager` helper
 * (apps/crowi-api/src/controllers/admin.ts:22-93) emits this exact bundle and
 * the React-side admin UI consumes it directly. We re-implement the helper on
 * the new server side so the wire format stays compatible.
 *
 * Differences from `PagerSchema` (schemas/page.ts):
 * - That one is an offset/prev/next bundle for infinite-scroll style lists.
 * - This one is a numbered pager (1..N + "..." dots) suited to a tabular list.
 *
 * Fields:
 * - page          : 1-based current page index.
 * - pagesCount    : Total number of pages (= ceil(total / limit), or 0 when
 *                   total is 0 — mongoose-paginate emits 0 in that case).
 * - pages         : Page numbers to render as buttons (windowed around `page`,
 *                   max length = MAX_PAGE_LIST = 5).
 * - total         : Total number of matching users.
 * - previous      : Previous page number, or null when on the first page.
 * - previousDots  : Whether to render a "..." between the leftmost button and
 *                   the windowed range (i.e. there are pages < pages[0] not
 *                   shown directly).
 * - next          : Next page number, or null when on the last page.
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

/**
 * Query parameters accepted by GET /admin/users.
 *
 * - `q` is the free-text search; legacy controller used `uq` but we adopt the
 *   shorter `q` for the new endpoint. See architecturalNotes in the migration
 *   task. The server side splits on whitespace and joins with `|` to build a
 *   single regex (case-insensitive) matched against username / name / email.
 * - `page` defaults to 1.
 * - `limit` defaults to 50 (== legacy User.PAGE_ITEMS) and is capped at 100.
 *
 * `z.coerce.number()` accepts the string-form values that arrive from
 * `req.query` while remaining typed as `number` downstream.
 */
export const ListAdminUsersRequestSchema = z.object({
  q: z.string().optional(),
  page: z.coerce.number().int().min(1).optional().default(1),
  limit: z.coerce.number().int().min(1).max(100).optional().default(50),
});
export type ListAdminUsersRequest = z.infer<typeof ListAdminUsersRequestSchema>;

/**
 * Response body for GET /admin/users.
 *
 * Note: even though the legacy endpoint also returned the original `uq` echo,
 * we drop it from the new contract — the client owns the search input state
 * and does not need the server to round-trip the query back.
 */
export const ListAdminUsersResponseSchema = z.object({
  users: z.array(UserPublicSchema),
  pager: AdminPagerSchema,
});
export type ListAdminUsersResponse = z.infer<typeof ListAdminUsersResponseSchema>;

/**
 * Query parameters for GET /admin/users/search (email autocomplete).
 *
 * The legacy endpoint accepted `email` and matched as a regex (with the
 * special characters escaped server-side). We preserve the same shape so
 * pre-existing autocomplete callers can switch to the new endpoint with
 * minimal change.
 */
export const SearchAdminUsersByEmailRequestSchema = z.object({
  email: z.string().min(1),
});
export type SearchAdminUsersByEmailRequest = z.infer<typeof SearchAdminUsersByEmailRequestSchema>;

/**
 * Response body for GET /admin/users/search.
 *
 * The legacy endpoint wrapped users in `{ data: [...] }`; the new shape uses
 * the more conventional `{ users: [...] }` for parity with the list endpoint.
 * Up to PAGE_ITEMS+1 (= 51) results are returned so a UI can detect "more
 * results than shown" without an extra count query.
 */
export const SearchAdminUsersByEmailResponseSchema = z.object({
  users: z.array(UserPublicSchema),
});
export type SearchAdminUsersByEmailResponse = z.infer<typeof SearchAdminUsersByEmailResponseSchema>;
