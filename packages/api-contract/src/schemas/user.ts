import { z } from 'zod';
import { PageSchema, PagerSchema } from './page';

// User status enum - matches User model constants
export const UserStatusSchema = z.enum(['1', '2', '3', '4', '5']).transform((val) => Number(val));
export const UserStatusEnum = {
  REGISTERED: 1,
  ACTIVE: 2,
  SUSPENDED: 3,
  DELETED: 4,
  INVITED: 5,
} as const;

// Language enum - matches User model
export const UserLanguageSchema = z.enum(['en', 'en-US', 'en-GB', 'ja']);
export type UserLanguage = z.infer<typeof UserLanguageSchema>;

// Public user schema - minimal user information for public display
// Based on UserDocument fields that are safe to expose publicly
export const UserPublicSchema = z.object({
  _id: z.string(),
  id: z.string().optional(), // for compatibility (virtual field)
  username: z.string(),
  name: z.string(),
  email: z.string().email(),
  image: z.string().nullable().optional(),
  introduction: z.string().optional(),
  createdAt: z.string(),
  admin: z.boolean().optional(),
  status: z.number().optional(),
});
export type UserPublic = z.infer<typeof UserPublicSchema>;

// Bookmark schema with populated page
export const BookmarkSchema = z.object({
  _id: z.string(),
  page: PageSchema,
  user: z.union([z.string(), UserPublicSchema]),
  createdAt: z.string(),
});
export type Bookmark = z.infer<typeof BookmarkSchema>;

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
