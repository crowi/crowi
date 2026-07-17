/**
 * RFC-0006 Phase 4 Batch 4 — `pagePreview` resource ported to
 * `@hono/zod-openapi`. Single endpoint:
 *
 *   POST /pages/preview — render arbitrary markdown to mdast
 *
 * Authentication is required (same as the rest of `/pages/*`); the
 * page handler chain reuses the `createJwtAuth(crowi)` apply installed
 * by the revision handler so this contract does not declare auth
 * middleware itself.
 *
 * Standalone contract (separate from `pageContract`) because preview
 * is a read-only render operation: no revision is created, no page
 * is fetched, and the contract has no permission scope tied to a
 * specific page — the input is raw markdown that may belong to no
 * persisted page at all.
 */
import { createRoute } from '@hono/zod-openapi';

import { AuthenticationRequiredErrorSchema, InternalServerErrorSchema } from '../schemas/common';
import { PreviewPageRequestSchema, PreviewPageResponseSchema, PreviewRateLimitErrorSchema } from '../schemas/page-preview';

export const previewPageRoute = createRoute({
  method: 'post',
  path: '/pages/preview',
  tags: ['page-preview'],
  security: [{ bearerAuth: [] }],
  summary: 'Render markdown to mdast for the editor preview pane',
  request: {
    body: {
      content: { 'application/json': { schema: PreviewPageRequestSchema } },
    },
  },
  responses: {
    200: {
      description: 'Rendered mdast tree (serialised — same shape as a persisted revision.renderedAst)',
      content: { 'application/json': { schema: PreviewPageResponseSchema } },
    },
    401: {
      description: 'Authentication required',
      content: { 'application/json': { schema: AuthenticationRequiredErrorSchema } },
    },
    429: {
      description: 'Per-user rate limit exceeded',
      content: { 'application/json': { schema: PreviewRateLimitErrorSchema } },
    },
    500: {
      description: 'Renderer pipeline failure',
      content: { 'application/json': { schema: InternalServerErrorSchema } },
    },
  },
});

export const pagePreviewRoutes = {
  previewPageRoute,
};
