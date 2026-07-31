import { z } from '@hono/zod-openapi';
import { PageSchema, PagerSchema } from './page';
import { BookmarkSchema } from './bookmark';
import { UserPublicSchema } from './user-public';

// NOTE: BookmarkSchema and UserPublicSchema are exported from their own
// dedicated files (./bookmark, ./user-public). They are intentionally NOT
// re-exported here to avoid duplicate-name conflicts in index.ts and to
// break a circular dependency between user.ts and bookmark.ts.

import { UserPublicStatus } from './user-public';

// User status enum - matches User model constants
export const UserStatusSchema = z.enum(['1', '2', '3', '4', '5']).transform((val) => Number(val));
// Backwards-compatible alias for the canonical enum in userPublic. Declared
// as a value-level const (rather than `export {as} from`) so tsup emits a
// straight reference instead of a renamed re-export — which v8 was
// surfacing as a stale shorthand-property in the bundled output.
export const UserStatusEnum = UserPublicStatus;

// Language enum - matches User model. Only `en` / `ja` are live UI locales;
// legacy regional variants (`en-US` / `en-GB`) were retired.
export const UserLanguageSchema = z.enum(['en', 'ja']);
export type UserLanguage = z.infer<typeof UserLanguageSchema>;

// Pagination request schema
export const PaginationRequestSchema = z.object({
  limit: z.coerce.number().optional().default(50),
  offset: z.coerce.number().optional().default(0),
});
export type PaginationRequest = z.infer<typeof PaginationRequestSchema>;

// Member-directory list item — the minimal public shape rendered on the
// `/user/` member directory (avatar + display name + @username + link).
// Intentionally narrower than UserPublicSchema: email and other PII are
// never surfaced in the directory.
export const UserListItemSchema = z.object({
  _id: z.string(),
  username: z.string(),
  name: z.string(),
  image: z.string().nullable().optional(),
});
export type UserListItem = z.infer<typeof UserListItemSchema>;

// Member-directory list request. `q` matches username/name (case-insensitive);
// pagination is offset-based to reuse the shared `Pager` envelope.
export const ListUsersRequestSchema = z.object({
  q: z.string().optional(),
  // Cap the page size so a client can't request the whole user table in one
  // unbounded find+sort (mirrors the page-list `limit` guard).
  limit: z.coerce.number().int().min(1).max(100).optional().default(24),
  offset: z.coerce.number().int().min(0).optional().default(0),
});
export type ListUsersRequest = z.infer<typeof ListUsersRequestSchema>;

// `GET /user/{username}/subpages` request — unlike `PaginationRequestSchema`
// (used by the sibling bookmarks/pages endpoints), `limit` is bounded:
// this endpoint recurses over the whole `/user/<username>/` namespace, so a
// single request costs more per row than a flat member-directory page. The
// bound is tighter than `ListUsersRequestSchema`'s 100 (30 default matches
// the web `UserRecentPages`/`UserBookmarks` full-mode Load More page size;
// the preview call passes `limit=10` explicitly). `offset` stays unbounded,
// matching the sibling `PaginationRequestSchema` — the walk cost is the same
// known characteristic as every other offset-paginated list (`GET
// /pages/list` included), so there is no reason to cap this endpoint alone.
export const UserSubpagesRequestSchema = z.object({
  limit: z.coerce.number().int().min(1).max(50).optional().default(30),
  offset: z.coerce.number().int().min(0).optional().default(0),
});
export type UserSubpagesRequest = z.infer<typeof UserSubpagesRequestSchema>;

// Member-directory list response — active users only, name-ascending.
export const ListUsersResponseSchema = z.object({
  users: z.array(UserListItemSchema),
  pager: PagerSchema,
  total: z.number(),
});
export type ListUsersResponse = z.infer<typeof ListUsersResponseSchema>;

// User page response schema - combines profile, bookmarks, and created pages
export const UserPageResponseSchema = z.object({
  user: UserPublicSchema,
  // Page statistics
  createdPagesCount: z.number(),
  bookmarksCount: z.number(),
  // feature-profile-stats-and-page-total — the target user's OWN actions:
  // pages they liked (`Page.liker` contains their id) and comments they
  // wrote (`Comment.creator` is their id). NOT activity their own pages
  // received from others, and not re-filtered by the viewer's grants —
  // see the spec's "プロフィール統計の主語と API 契約" section.
  likesCount: z.number(),
  commentsCount: z.number(),
  // Optionally include recent items for initial display
  recentPages: z.array(PageSchema).optional(),
  recentBookmarks: z.array(BookmarkSchema).optional(),
});
export type UserPageResponse = z.infer<typeof UserPageResponseSchema>;

// User bookmarks response schema - paginated bookmarks list
export const UserBookmarksResponseSchema = z.object({
  bookmarks: z.array(BookmarkSchema),
  pager: PagerSchema,
  total: z.number(),
});
export type UserBookmarksResponse = z.infer<typeof UserBookmarksResponseSchema>;

// User pages response schema - paginated pages list
export const UserPagesResponseSchema = z.object({
  pages: z.array(PageSchema),
  pager: PagerSchema,
  total: z.number(),
});
export type UserPagesResponse = z.infer<typeof UserPagesResponseSchema>;

// User not found error schema
export const UserNotFoundErrorSchema = z.object({
  error: z.object({
    code: z.literal('USER_NOT_FOUND'),
    message: z.literal('User not found'),
  }),
});
export type UserNotFoundError = z.infer<typeof UserNotFoundErrorSchema>;
