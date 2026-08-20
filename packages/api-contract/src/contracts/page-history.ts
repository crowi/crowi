import { createRoute, z } from '@hono/zod-openapi';

import { AuthenticationRequiredErrorSchema } from '../schemas/common';
import { PageNotFoundErrorSchema } from '../schemas/page';
import { PageHistoryPageIdParamSchema, PageHistoryQuerySchema, PageHistoryResponseSchema } from '../schemas/page-history';

/**
 * RFC-0021 Phase 3 — the merged page timeline.
 *
 * The path is relative to wherever the app is mounted; it carries no `/api`
 * prefix of its own.
 */
export const getPageHistoryRoute = createRoute({
  method: 'get',
  path: '/pages/{pageId}/history',
  tags: ['page'],
  security: [{ bearerAuth: [] }],
  summary: "A page's content revisions and metadata events as one timeline, newest first",
  request: {
    params: PageHistoryPageIdParamSchema,
    query: PageHistoryQuerySchema,
  },
  responses: {
    200: {
      description: 'One page of the timeline, plus a cursor when more remains',
      content: { 'application/json': { schema: PageHistoryResponseSchema } },
    },
    400: {
      description: 'Malformed page id, cursor, or query',
      content: { 'application/json': { schema: z.object({ error: z.object({ code: z.string(), message: z.string() }) }) } },
    },
    401: {
      description: 'Authentication required',
      content: { 'application/json': { schema: AuthenticationRequiredErrorSchema } },
    },
    404: {
      description: 'Page not found (also covers grant-denied)',
      content: { 'application/json': { schema: PageNotFoundErrorSchema } },
    },
    500: {
      description: 'The timeline could not be read — includes the page identifier so an operator can run the repair',
      content: { 'application/json': { schema: z.object({ error: z.object({ code: z.string(), message: z.string(), pageId: z.string().optional() }) }) } },
    },
  },
});

/** Grouped the same way every other resource is, so the OpenAPI generator's route enumeration picks it up. */
export const pageHistoryRoutes = { getPageHistoryRoute };
