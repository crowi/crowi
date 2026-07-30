import { z } from '@hono/zod-openapi';
import { PageSchema } from './page';

/**
 * Page-type filter for search. Mirrors `SearchPageType` in
 * `@crowi/plugin-api` (`portal` / `public` / `user`):
 *   - `portal`: directory-style pages (path ends with `/`), excluding `/user/*`
 *   - `public`: leaf pages (path does not end with `/`), excluding `/user/*`
 *   - `user`:   `/user/*` pages
 *
 * Single value only in v0.1; the driver-side `SearchQuery.grants.types` is
 * an array, but the contract receives one value and the handler wraps it
 * as `[type]`. Multiple values may be supported in a future contract version.
 */
export const SearchPageTypeSchema = z.enum(['portal', 'public', 'user']);
export type SearchPageType = z.infer<typeof SearchPageTypeSchema>;

/**
 * Request schema for `GET /api/search`.
 *
 * - `q` is required and must be non-empty (legacy parity with
 *   `controllers/search.ts:!keyword`).
 * - `tree` is an optional path-prefix filter (e.g. `/team/eng/`); the legacy
 *   parameter name is preserved.
 * - `type` is an optional page-type filter (single value).
 * - `page` defaults to 1 (1-based), `limit` defaults to 50 and is capped at 100.
 */
export const SearchPagesRequestSchema = z.object({
  q: z.string().min(1),
  tree: z.string().optional(),
  type: SearchPageTypeSchema.optional(),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});
export type SearchPagesRequest = z.infer<typeof SearchPagesRequestSchema>;

/**
 * One hit returned by the search backend, joined with Crowi page data.
 *
 * `snippet` carries the driver-supplied highlight string (typically with
 * `<mark>` tokens around matched terms). The handler does NOT escape it;
 * the web client is responsible for sanitising it (allow-list of tags)
 * before rendering. Driver-specific tag sets stay opaque to the API layer.
 */
export const SearchHitSchema = z.object({
  pageId: z.string(),
  path: z.string(),
  score: z.number().optional(),
  snippet: z.string().optional(),
  bookmarkCount: z.number(),
  page: PageSchema,
});
export type SearchHit = z.infer<typeof SearchHitSchema>;

/**
 * Response schema for `GET /api/search`.
 *
 * - `meta.total` is the total number of matches across all pages (driver-reported).
 * - `meta.results` is the count in this response page (= `data.length`).
 * - `meta.took` is optional ms; not all drivers report it (mongo regex omits it).
 */
export const SearchPagesResponseSchema = z.object({
  meta: z.object({
    took: z.number().optional(),
    total: z.number(),
    results: z.number(),
  }),
  data: z.array(SearchHitSchema),
});
export type SearchPagesResponse = z.infer<typeof SearchPagesResponseSchema>;
