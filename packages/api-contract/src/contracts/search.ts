/**
 * RFC-0006 Phase 4 Batch 7 — `search` resource ported to
 * `@hono/zod-openapi` route definitions. Single endpoint:
 *
 *   GET /search — full-text search over indexed pages
 *
 * Auth + install:
 *   - `/search` is a singleton literal path, OUTSIDE the revision-owned
 *     `/pages/*` jwtAuth apply. The search handler installs
 *     `createJwtAuth(crowi)` on this exact path itself — same single-route
 *     install pattern as `autocomplete`'s `/users/autocomplete`.
 *   - No rate limit. The legacy `/api/search` had no `withRateLimit`
 *     wrapping (search backend latency naturally throttles bursts) and the
 *     RFC does not require one for this resource.
 *
 * Service-availability semantics:
 *   - `crowi.getSearcher()` returns `null` when no
 *     `@crowi/plugin-search-*` is installed in the runner project. The
 *     handler returns 503 `SERVICE_UNAVAILABLE` with `feature: 'search'`
 *     so clients can branch on the missing-subsystem case (the web app
 *     surfaces a "search is disabled" panel).
 *   - The driver itself runs grant-aware filtering (viewer id / username
 *     / isAdmin are forwarded) so unauthorised hits never leak.
 *   - `data[].snippet` carries the driver-supplied highlight string
 *     verbatim (typically with `<mark>` tokens). The handler does NOT
 *     escape it; web clients must sanitise before HTML render.
 *
 * The legacy `GET /_api/search` Express endpoint stays mounted in
 * parallel until Phase 6 cleanup.
 */
import { createRoute } from '@hono/zod-openapi';

import { AuthenticationRequiredErrorSchema, InternalServerErrorSchema, ServiceUnavailableErrorSchema, ValidationErrorSchema } from '../schemas/common';
import { SearchPagesRequestSchema, SearchPagesResponseSchema } from '../schemas/search';

export const searchPagesRoute = createRoute({
  method: 'get',
  path: '/search',
  tags: ['search'],
  security: [{ bearerAuth: [] }],
  summary: 'Full-text search over pages',
  request: {
    query: SearchPagesRequestSchema,
  },
  responses: {
    200: {
      description: 'Ranked search hits joined with page + bookmark count metadata',
      content: { 'application/json': { schema: SearchPagesResponseSchema } },
    },
    400: {
      description: 'Validation error (e.g. empty `q`, invalid `type` enum)',
      content: { 'application/json': { schema: ValidationErrorSchema } },
    },
    401: {
      description: 'Authentication required',
      content: { 'application/json': { schema: AuthenticationRequiredErrorSchema } },
    },
    500: {
      description: 'Search driver raised an unexpected error',
      content: { 'application/json': { schema: InternalServerErrorSchema } },
    },
    503: {
      description: 'No search driver registered (install `@crowi/plugin-search-*`)',
      content: { 'application/json': { schema: ServiceUnavailableErrorSchema } },
    },
  },
});

export const searchRoutes = {
  searchPagesRoute,
};
