import { z } from 'zod';
import { UserPublicSchema } from './userPublic';

// 24-character hex ObjectId string. Mirrors isValidObjectId in
// apps/crowi-api/src/util/ts-rest-helpers.ts so request validation rejects
// non-ObjectId strings at the contract boundary.
const ObjectIdString = z.string().regex(/^[0-9a-f]{24}$/, 'Invalid ObjectId');

// `fromPage` is populated by Backlink.findByPageId; only the `path` is used
// by the legacy UI. Keep the shape minimal so we don't lock in fields the
// API may stop populating later.
export const BacklinkFromPageSchema = z.object({
  _id: z.string(),
  path: z.string(),
});
export type BacklinkFromPage = z.infer<typeof BacklinkFromPageSchema>;

// `fromRevision` is populated alongside its `author` (a UserPublic). The
// legacy UI rendered the author's avatar next to the source page link.
export const BacklinkFromRevisionSchema = z.object({
  _id: z.string(),
  author: UserPublicSchema.nullable().optional(),
});
export type BacklinkFromRevision = z.infer<typeof BacklinkFromRevisionSchema>;

export const BacklinkSchema = z.object({
  _id: z.string(),
  // The destination page's id (the page being linked TO). Always the
  // page passed in the request, but echoed for cache-key parity with the
  // legacy response.
  page: z.string(),
  fromPage: BacklinkFromPageSchema,
  fromRevision: BacklinkFromRevisionSchema,
  updatedAt: z.string(),
});
export type Backlink = z.infer<typeof BacklinkSchema>;

export const GetBacklinksRequestSchema = z.object({
  page_id: ObjectIdString,
  limit: z.coerce.number().int().min(1).max(100).optional().default(20),
  offset: z.coerce.number().int().min(0).optional().default(0),
});
export type GetBacklinksRequest = z.infer<typeof GetBacklinksRequestSchema>;

// `hasNext` lets the UI render a "Read More" affordance without the legacy
// limit+1 over-fetch trick. The server fetches limit+1 internally and trims
// to `limit` before returning.
export const GetBacklinksResponseSchema = z.object({
  backlinks: z.array(BacklinkSchema),
  hasNext: z.boolean(),
});
export type GetBacklinksResponse = z.infer<typeof GetBacklinksResponseSchema>;
