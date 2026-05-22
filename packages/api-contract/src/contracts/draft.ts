/**
 * RFC-0006 Phase 4 Batch 6 — `draft` resource ported to
 * `@hono/zod-openapi` route definitions. Three endpoints (RFC-0004
 * Phase 3 — drafts):
 *
 *   POST   /pages/drafts        — create a draft at a path
 *   GET    /pages/drafts        — list the caller's own drafts
 *   DELETE /pages/drafts/{id}   — cancel a draft
 *
 * All endpoints require JWT auth. The Hono handler does NOT install
 * `createJwtAuth(crowi)` itself — the `revision` handler's broad apply
 * on `/pages/*` (registered first in `buildHonoApp`) covers the
 * `/pages/drafts*` literals. Same dedupe-avoidance rationale as
 * `page` / `page-preview` / `pageCollab` / `presence`.
 *
 * The literal `/pages/drafts` sub-path wins over a `/pages/{id}`
 * template in Hono's method+path dispatch, so order between this
 * handler and the page handler is purely organisational.
 */
import { createRoute, z } from '@hono/zod-openapi';

import { AuthenticationRequiredErrorSchema } from '../schemas/common';
import {
  CreateDraftRequestSchema,
  CreateDraftResponseSchema,
  DraftBadRequestErrorSchema,
  DraftNotFoundErrorSchema,
  DraftPathConflictErrorSchema,
  ListDraftsResponseSchema,
} from '../schemas/draft';

const DraftIdPathParamsSchema = z.object({
  id: z.string().openapi({ description: 'Draft page id (24-char hex ObjectId)', example: '507f1f77bcf86cd799439011' }),
});

export const createDraftRoute = createRoute({
  method: 'post',
  path: '/pages/drafts',
  tags: ['draft'],
  security: [{ bearerAuth: [] }],
  summary: 'Create a new draft page at a path',
  request: {
    body: {
      content: { 'application/json': { schema: CreateDraftRequestSchema } },
    },
  },
  responses: {
    201: {
      description: 'Draft created (or the caller already holds a draft at this path — idempotent)',
      content: { 'application/json': { schema: CreateDraftResponseSchema } },
    },
    400: {
      description: 'Uncreatable path, or path already held by a published page',
      content: { 'application/json': { schema: DraftBadRequestErrorSchema } },
    },
    401: {
      description: 'Authentication required',
      content: { 'application/json': { schema: AuthenticationRequiredErrorSchema } },
    },
    409: {
      description: "Another user's draft already occupies the path",
      content: { 'application/json': { schema: DraftPathConflictErrorSchema } },
    },
  },
});

export const listDraftsRoute = createRoute({
  method: 'get',
  path: '/pages/drafts',
  tags: ['draft'],
  security: [{ bearerAuth: [] }],
  summary: "List the current user's draft pages",
  responses: {
    200: {
      description: 'Caller-scoped draft list (newest first)',
      content: { 'application/json': { schema: ListDraftsResponseSchema } },
    },
    401: {
      description: 'Authentication required',
      content: { 'application/json': { schema: AuthenticationRequiredErrorSchema } },
    },
  },
});

export const cancelDraftRoute = createRoute({
  method: 'delete',
  path: '/pages/drafts/{id}',
  tags: ['draft'],
  security: [{ bearerAuth: [] }],
  summary: 'Cancel (delete) a draft page',
  request: {
    params: DraftIdPathParamsSchema,
  },
  responses: {
    200: {
      description: 'Draft cancelled; the path is released',
      content: { 'application/json': { schema: CreateDraftResponseSchema } },
    },
    401: {
      description: 'Authentication required',
      content: { 'application/json': { schema: AuthenticationRequiredErrorSchema } },
    },
    404: {
      description: 'Draft not found, or owned by a different user (existence leak guard)',
      content: { 'application/json': { schema: DraftNotFoundErrorSchema } },
    },
  },
});

export const draftRoutes = {
  createDraftRoute,
  listDraftsRoute,
  cancelDraftRoute,
};
