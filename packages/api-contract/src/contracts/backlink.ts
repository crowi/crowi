/**
 * RFC-0006 Phase 4 Batch 3 — `backlink` resource ported to
 * `@hono/zod-openapi` route definitions. Single endpoint:
 *
 *   GET /backlinks — list backlinks targeting a page
 *
 * Requires JWT authentication. The Hono handler applies
 * `createJwtAuth(crowi)` broadly to `/backlinks/*` so `c.get('user')`
 * is always populated. Query parameters keep their ts-rest-era shape
 * (`page_id` is the 24-hex target page id; `limit` / `offset` are
 * coerced from URL strings and bounds-checked).
 */
import { createRoute } from '@hono/zod-openapi';

import { GetBacklinksRequestSchema, GetBacklinksResponseSchema } from '../schemas/backlink';
import { AuthenticationRequiredErrorSchema, InvalidPageIdErrorSchema } from '../schemas/common';

export const getBacklinksRoute = createRoute({
  method: 'get',
  path: '/backlinks',
  tags: ['backlink'],
  security: [{ bearerAuth: [] }],
  summary: 'List backlinks targeting a page',
  request: {
    query: GetBacklinksRequestSchema,
  },
  responses: {
    200: {
      description: 'Backlinks targeting the page (trimmed to `limit`; `hasNext` flags whether more exist)',
      content: { 'application/json': { schema: GetBacklinksResponseSchema } },
    },
    400: {
      description: 'Invalid page_id',
      content: { 'application/json': { schema: InvalidPageIdErrorSchema } },
    },
    401: {
      description: 'Authentication required',
      content: { 'application/json': { schema: AuthenticationRequiredErrorSchema } },
    },
  },
});

export const backlinkRoutes = {
  getBacklinksRoute,
};
