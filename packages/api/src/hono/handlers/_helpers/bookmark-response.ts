/**
 * Shared `bookmarkToResponse` serializer used by `bookmark.ts` and
 * `user.ts` (both expose a bookmark-embedding response shape).
 */
import type { Types } from 'mongoose';

import type Crowi from 'src/crowi';
import type { BookmarkDocument } from 'src/models/bookmark';
import type { PageDocument } from 'src/models/page';
import type { UserDocument } from 'src/models/user';
import { type EnrichedPage, type PageLike, pageToResponse, populatePageRelationData } from 'src/util/page-response';
import { type PopulatedUser, isPopulatedUser, toISOStringOrNull, toPageUser, toStringId } from 'src/util/ts-rest-helpers';

export interface BookmarkLike {
  _id: Types.ObjectId | string;
  page?: PageLike | null;
  user: PopulatedUser | Types.ObjectId | string;
  createdAt?: Date;
  toObject?: () => BookmarkLike;
}

/**
 * Serialize a Bookmark document into the wire shape (feature-page-relations-collections
 * D-2). `bookmark` supplies `_id` / `user` / `createdAt` only — `page` is
 * NEVER read off `bookmark.page` (or its `toObject()` re-serialization,
 * which drops the enrichment fields `Object.assign`-mutated onto a
 * populated Page document); it always comes from `enrichedPage`, resolved
 * by the caller via `populatePageRelationData` and matched to this
 * bookmark by page id. `enrichedPage: null` means either "no page to
 * show" or (for `getBookmarkRoute`, which does not use this helper at
 * all — see that route) not applicable.
 */
export const bookmarkToResponse = (bookmark: BookmarkDocument | BookmarkLike, enrichedPage: EnrichedPage | null) => {
  const obj: BookmarkLike =
    typeof (bookmark as BookmarkDocument).toObject === 'function' ? (bookmark as BookmarkDocument).toObject() : (bookmark as BookmarkLike);
  return {
    _id: toStringId(obj._id),
    page: enrichedPage ? pageToResponse(enrichedPage) : null,
    user: isPopulatedUser(obj.user) ? toPageUser(obj.user) : toStringId(obj.user as Types.ObjectId | string),
    createdAt: toISOStringOrNull(obj.createdAt) || new Date().toISOString(),
  };
};

/**
 * `bookmark.ts`'s `listMyBookmarksRoute` and `user.ts`'s
 * `getUserBookmarksRoute` both page through a `BookmarkDocument[]` (already
 * filtered to entries with a populated `page`) and need the identical D-2
 * pipeline: one batched `populatePageRelationData` call for every bookmarked
 * Page, matched back to its bookmark by page id (never by array position —
 * see `bookmarkToResponse`'s doc comment), then serialized. Pulled out here
 * so both call sites share it verbatim instead of re-deriving the same
 * map-by-id.
 */
export async function bookmarksToResponseList(crowi: Crowi, bookmarks: BookmarkDocument[], viewer: UserDocument | null) {
  const pages = bookmarks.map((bookmark) => bookmark.page as PageDocument);
  const enrichedPages = await populatePageRelationData(crowi, pages, viewer);
  const enrichedByPageId = new Map<string, EnrichedPage>(enrichedPages.map((page) => [toStringId(page._id), page]));
  return bookmarks.map((bookmark) => bookmarkToResponse(bookmark, enrichedByPageId.get(toStringId((bookmark.page as PageDocument)._id)) ?? null));
}
