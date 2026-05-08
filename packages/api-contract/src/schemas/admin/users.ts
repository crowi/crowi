import { z } from 'zod';
import { UserPublicSchema } from '../userPublic';
import { AdminPagerSchema } from './_pager';

export { AdminPagerSchema, type AdminPager } from './_pager';

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
