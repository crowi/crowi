/**
 * RFC-0006 Phase 4 Batch 3 — `revision` resource ported to
 * `@hono/zod-openapi` route definitions. Three endpoints:
 *
 *   GET /pages/{page_id}/revisions       — list revisions of a page (meta only)
 *   GET /pages/revisions                 — fetch multiple revisions by ids
 *   GET /pages/revisions/{id}            — fetch a single revision (with body)
 *
 * All endpoints require JWT authentication. The Hono handler applies
 * `createJwtAuth(crowi)` broadly to `/pages/*` so `c.get('user')` is
 * populated; the broad apply intentionally overlaps with the future
 * `page` resource (Batch 4) — both handlers share the same middleware
 * instance via Hono's deduping (`app.use(path, mw)` is idempotent on
 * the same middleware reference within a single chain).
 *
 * `getRevisionsRoute` (`/pages/revisions`) must register BEFORE
 * `getRevisionRoute` (`/pages/revisions/{id}`) so Hono's pattern
 * matcher resolves `?ids=...` to the list-by-ids route rather than
 * treating `revisions` as the path param `id` value. The runtime
 * handler chain in `packages/api/src/hono/handlers/revision.ts` and
 * the stub chain in `client.ts` follow the same order.
 */
import { createRoute, z } from '@hono/zod-openapi';

import { AuthenticationRequiredErrorSchema } from '../schemas/common';
import { PageNotFoundErrorSchema } from '../schemas/page';
import {
  GetRevisionResponseSchema,
  GetRevisionsRequestSchema,
  GetRevisionsResponseSchema,
  ListRevisionsRequestSchema,
  ListRevisionsResponseSchema,
  RevisionInvalidRequestErrorSchema,
} from '../schemas/revision';

const PageIdParamSchema = z.object({ page_id: z.string() });
const RevisionIdParamSchema = z.object({ id: z.string() });

export const listRevisionsRoute = createRoute({
  method: 'get',
  path: '/pages/{page_id}/revisions',
  tags: ['revision'],
  security: [{ bearerAuth: [] }],
  summary: 'List revisions of a page (meta only)',
  request: {
    params: PageIdParamSchema,
    query: ListRevisionsRequestSchema,
  },
  responses: {
    200: {
      description: 'Revision metadata (no body), newest first',
      content: { 'application/json': { schema: ListRevisionsResponseSchema } },
    },
    400: {
      description: 'Invalid request',
      content: { 'application/json': { schema: RevisionInvalidRequestErrorSchema } },
    },
    401: {
      description: 'Authentication required',
      content: { 'application/json': { schema: AuthenticationRequiredErrorSchema } },
    },
    404: {
      description: 'Page not found (also covers grant-denied to avoid leaking existence)',
      content: { 'application/json': { schema: PageNotFoundErrorSchema } },
    },
  },
});

export const getRevisionsRoute = createRoute({
  method: 'get',
  path: '/pages/revisions',
  tags: ['revision'],
  security: [{ bearerAuth: [] }],
  summary: 'Get multiple revisions by ids (comma-separated)',
  request: {
    query: GetRevisionsRequestSchema,
  },
  responses: {
    200: {
      description: 'Requested revisions (all must share the same path)',
      content: { 'application/json': { schema: GetRevisionsResponseSchema } },
    },
    400: {
      description: 'Invalid request',
      content: { 'application/json': { schema: RevisionInvalidRequestErrorSchema } },
    },
    401: {
      description: 'Authentication required',
      content: { 'application/json': { schema: AuthenticationRequiredErrorSchema } },
    },
    404: {
      description: 'No matching revisions or page not found (also covers grant-denied)',
      content: { 'application/json': { schema: PageNotFoundErrorSchema } },
    },
  },
});

export const getRevisionRoute = createRoute({
  method: 'get',
  path: '/pages/revisions/{id}',
  tags: ['revision'],
  security: [{ bearerAuth: [] }],
  summary: 'Get a single revision (with body)',
  request: {
    params: RevisionIdParamSchema,
  },
  responses: {
    200: {
      description:
        'Full revision document. `renderedAst` shape is content-negotiated via the `X-Crowi-Ast-Version` request header (RFC-0023): requests declaring `X-Crowi-Ast-Version: 1` receive the typed `{astVersion, root}` envelope; all other requests receive the stored bare mdast Root verbatim. The response varies on this header (`Vary: X-Crowi-Ast-Version`).',
      content: { 'application/json': { schema: GetRevisionResponseSchema } },
    },
    400: {
      description: 'Invalid revision id',
      content: { 'application/json': { schema: RevisionInvalidRequestErrorSchema } },
    },
    401: {
      description: 'Authentication required',
      content: { 'application/json': { schema: AuthenticationRequiredErrorSchema } },
    },
    404: {
      description: 'Revision or page not found (also covers grant-denied)',
      content: { 'application/json': { schema: PageNotFoundErrorSchema } },
    },
  },
});

export const revisionRoutes = {
  listRevisionsRoute,
  // `getRevisionsRoute` (list-by-ids) must come before `getRevisionRoute`
  // (single by id) so Hono matches `/pages/revisions?ids=a,b` before
  // falling through to the `{id}` template. See the file header.
  getRevisionsRoute,
  getRevisionRoute,
};
