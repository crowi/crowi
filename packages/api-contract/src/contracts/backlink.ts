import { initContract } from '@ts-rest/core';
import { GetBacklinksRequestSchema, GetBacklinksResponseSchema } from '../schemas/backlink';
import { AuthenticationRequiredErrorSchema, InvalidPageIdErrorSchema } from '../schemas/common';

const c = initContract();

export const backlinkContract = c.router({
  /**
   * GET /api/v2/backlinks
   * List backlinks targeting the given page.
   *
   * - Requires authentication (jwtAuth).
   * - `limit` defaults to 20 (max 100); `offset` defaults to 0.
   * - Returns `{ backlinks, hasNext }`. `hasNext` reflects whether at least
   *   one more record exists past `offset + limit`; the server fetches
   *   limit+1 internally and trims to `limit` before responding.
   * - Equivalent to legacy GET /_api/backlink.list, with the addition of
   *   `hasNext` for pagination.
   */
  getBacklinks: {
    method: 'GET',
    path: '/backlinks',
    query: GetBacklinksRequestSchema,
    responses: {
      200: GetBacklinksResponseSchema,
      400: InvalidPageIdErrorSchema,
      401: AuthenticationRequiredErrorSchema,
    },
    summary: 'List backlinks targeting a page',
  },
});
