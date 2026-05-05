import { z } from 'zod';
import { PageSchema, PagerSchema } from './page';
import { UserPublicSchema } from './userPublic';

// Bookmark schema with populated page
// (Originally lived in schemas/user.ts; relocated for reuse across contracts)
export const BookmarkSchema = z.object({
  _id: z.string(),
  page: PageSchema,
  user: z.union([z.string(), UserPublicSchema]),
  createdAt: z.string(),
});
export type Bookmark = z.infer<typeof BookmarkSchema>;

// GET /bookmarks?page_id=xxx
export const GetBookmarkRequestSchema = z.object({
  page_id: z.string(),
});
export type GetBookmarkRequest = z.infer<typeof GetBookmarkRequestSchema>;

// GET /bookmarks  → { bookmark: Bookmark | null }
// POST /bookmarks → { bookmark: Bookmark | null }
export const BookmarkResponseSchema = z.object({
  bookmark: BookmarkSchema.nullable(),
});
export type BookmarkResponse = z.infer<typeof BookmarkResponseSchema>;

// GET /bookmarks/me?limit&offset
export const ListMyBookmarksResponseSchema = z.object({
  bookmarks: z.array(BookmarkSchema),
  pager: PagerSchema,
  total: z.number(),
});
export type ListMyBookmarksResponse = z.infer<typeof ListMyBookmarksResponseSchema>;

// POST /bookmarks { page_id }
export const AddBookmarkRequestSchema = z.object({
  page_id: z.string(),
});
export type AddBookmarkRequest = z.infer<typeof AddBookmarkRequestSchema>;

// DELETE /bookmarks { page_id }
export const RemoveBookmarkRequestSchema = z.object({
  page_id: z.string(),
});
export type RemoveBookmarkRequest = z.infer<typeof RemoveBookmarkRequestSchema>;

export const RemoveBookmarkResponseSchema = z.object({
  ok: z.literal(true),
});
export type RemoveBookmarkResponse = z.infer<typeof RemoveBookmarkResponseSchema>;

// Errors specific to bookmark
export const InvalidPageIdErrorSchema = z.object({
  error: z.object({
    code: z.literal('INVALID_PAGE_ID'),
    message: z.string(),
  }),
});
export type InvalidPageIdError = z.infer<typeof InvalidPageIdErrorSchema>;
