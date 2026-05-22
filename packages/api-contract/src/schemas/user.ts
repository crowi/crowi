import { z } from '@hono/zod-openapi';
import { PageSchema, PagerSchema } from './page';
import { BookmarkSchema } from './bookmark';
import { UserPublicSchema } from './userPublic';

// NOTE: BookmarkSchema and UserPublicSchema are exported from their own
// dedicated files (./bookmark, ./userPublic). They are intentionally NOT
// re-exported here to avoid duplicate-name conflicts in index.ts and to
// break a circular dependency between user.ts and bookmark.ts.

import { UserPublicStatus } from './userPublic';

// User status enum - matches User model constants
export const UserStatusSchema = z.enum(['1', '2', '3', '4', '5']).transform((val) => Number(val));
// Backwards-compatible alias for the canonical enum in userPublic. Declared
// as a value-level const (rather than `export {as} from`) so tsup emits a
// straight reference instead of a renamed re-export — which v8 was
// surfacing as a stale shorthand-property in the bundled output.
export const UserStatusEnum = UserPublicStatus;

// Language enum - matches User model
export const UserLanguageSchema = z.enum(['en', 'en-US', 'en-GB', 'ja']);
export type UserLanguage = z.infer<typeof UserLanguageSchema>;

// Pagination request schema
export const PaginationRequestSchema = z.object({
  limit: z.coerce.number().optional().default(50),
  offset: z.coerce.number().optional().default(0),
});
export type PaginationRequest = z.infer<typeof PaginationRequestSchema>;

// User page response schema - combines profile, bookmarks, and created pages
export const UserPageResponseSchema = z.object({
  user: UserPublicSchema,
  // Page statistics
  createdPagesCount: z.number(),
  bookmarksCount: z.number(),
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
