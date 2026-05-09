import { initContract } from '@ts-rest/core';
import { SearchPagesRequestSchema, SearchPagesResponseSchema } from '../schemas/search';
import { AuthenticationRequiredErrorSchema, InternalServerErrorSchema, ServiceUnavailableErrorSchema, ValidationErrorSchema } from '../schemas/common';

const c = initContract();

export const searchContract = c.router({
  /**
   * GET /api/v2/search
   * Run a full-text search over indexed pages.
   *
   * - Requires authentication (jwtAuth). The viewer (id / username / isAdmin)
   *   is derived from `req.user` and forwarded to the active SearchDriver,
   *   which applies grant-aware filtering (GRANT_OWNER / GRANT_RESTRICTED /
   *   GRANT_SPECIFIED) so unauthorised hits never leak through.
   * - `type` is forwarded as `grants.types: [type]` to the driver. Single
   *   value only in v0.1.
   * - Returns 503 SERVICE_UNAVAILABLE (`feature: 'search'`) when no search
   *   driver plugin is registered. Operators must install one of
   *   `@crowi/plugin-search-elasticsearch` / future `@crowi/plugin-search-mongo`
   *   in the runner project to enable this endpoint.
   * - The `data[].snippet` field carries the driver-supplied highlight
   *   string verbatim (typically with `<mark>` tokens). The handler does
   *   not escape it; web clients must sanitise before HTML render.
   * - The legacy `GET /_api/search` endpoint is left mounted in parallel;
   *   its removal is tracked as a separate clean-up task.
   */
  searchPages: {
    method: 'GET',
    path: '/search',
    query: SearchPagesRequestSchema,
    responses: {
      200: SearchPagesResponseSchema,
      400: ValidationErrorSchema,
      401: AuthenticationRequiredErrorSchema,
      500: InternalServerErrorSchema,
      503: ServiceUnavailableErrorSchema,
    },
    summary: 'Full-text search over pages',
  },
});
