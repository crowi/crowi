import { z } from '@hono/zod-openapi';
import { PageSchema, PagerSchema } from './page';
import { UserPublicSchema } from './user-public';

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

// POST /bookmarks → { bookmark: Bookmark | null }
export const BookmarkResponseSchema = z.object({
  bookmark: BookmarkSchema.nullable(),
});
export type BookmarkResponse = z.infer<typeof BookmarkResponseSchema>;

// GET /bookmarks → { bookmark: GetBookmark | null }
//
// feature-page-relations-collections D-2 — a BREAKING wire change from the
// shared `BookmarkResponseSchema` above: `Bookmark.findByPageIdAndUserId`
// (the handler's only lookup for this route) never populates `page`, so
// `bookmark.page` is a bare id, not a `PageSchema` object. The prior
// contract declared it as `PageSchema` anyway — an existing, unfixed
// inaccuracy this spec resolves by giving `getBookmarkRoute` its own
// response schema instead of adding enrichment this route never had.
// crowi 2.0 is unreleased, so this break needs no migration story.
export const GetBookmarkSchema = z.object({
  _id: z.string(),
  page: z.string().nullable(),
  user: z.union([z.string(), UserPublicSchema]),
  createdAt: z.string(),
});
export type GetBookmark = z.infer<typeof GetBookmarkSchema>;

export const GetBookmarkResponseSchema = z.object({
  bookmark: GetBookmarkSchema.nullable(),
});
export type GetBookmarkResponse = z.infer<typeof GetBookmarkResponseSchema>;

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
