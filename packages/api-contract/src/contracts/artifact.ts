/**
 * The routes that actually stream the artifact's HTML bytes back to the
 * browser return raw, non-JSON responses and are hand-coded Hono handlers
 * outside this contract layer (`hono/handlers/artifact-stream.ts`) — only
 * this URL-minting endpoint fits the JSON request/response shape a contract
 * route requires.
 *
 * Uses inherited `/pages/*` JWT auth from registerRevisionRoutes;
 * scope enforcement happens at registration via applyScope.
 * Separated into its own file (like page-collab.ts) to keep page.ts focused.
 */
import { createRoute, z } from '@hono/zod-openapi';

import { ArtifactUrlUnavailableErrorSchema, MintArtifactUrlRequestSchema, MintArtifactUrlResponseSchema } from '../schemas/artifact';
import { AuthenticationRequiredErrorSchema, InternalServerErrorSchema, InvalidPageIdErrorSchema, ValidationErrorSchema } from '../schemas/common';
import { InsufficientScopeErrorSchema } from '../schemas/oauth';
import { PageNotFoundErrorSchema } from '../schemas/page';

const PageIdPathParamsSchema = z.object({
  id: z.string().openapi({ description: 'Page id (24-char hex ObjectId)', example: '507f1f77bcf86cd799439011' }),
});

/**
 * POST /api/pages/:id/artifact-url
 *
 * Mints a signed delivery URL for the Page's HTML artifact.
 * Target revision defaults to current, or an explicit `revisionId` can be specified.
 *
 * Authorisation:
 *   - 401 if the caller is unauthenticated.
 *   - 403 if the caller's token lacks the `pages:read` scope.
 *   - 400 if `:id` is not a 24-char hex ObjectId, the request body fails
 *     validation, or the target revision exists but is not an HTML artifact.
 *   - 404 if the page does not exist, the caller is not granted access, or
 *     `revisionId` names a revision that does not belong to this page.
 *   - 422 if HTML artifact delivery is not configured on this server.
 *   - 500 on an unexpected failure.
 */
export const mintArtifactUrlRoute = createRoute({
  method: 'post',
  path: '/pages/{id}/artifact-url',
  tags: ['artifact'],
  security: [{ bearerAuth: [] }],
  summary: 'Mint a signed delivery URL for a Page HTML artifact',
  request: {
    params: PageIdPathParamsSchema,
    body: {
      content: { 'application/json': { schema: MintArtifactUrlRequestSchema } },
    },
  },
  responses: {
    200: {
      description: 'Signed artifact URL minted',
      content: { 'application/json': { schema: MintArtifactUrlResponseSchema } },
    },
    400: {
      description: 'Invalid page id, invalid request body, or the target revision is not an HTML artifact',
      content: { 'application/json': { schema: z.union([InvalidPageIdErrorSchema, ValidationErrorSchema, ArtifactUrlUnavailableErrorSchema]) } },
    },
    401: {
      description: 'Authentication required',
      content: { 'application/json': { schema: AuthenticationRequiredErrorSchema } },
    },
    403: {
      description: 'The access token does not grant pages:read',
      content: { 'application/json': { schema: InsufficientScopeErrorSchema } },
    },
    404: {
      description: 'Page not found, not granted, or the revision does not belong to this page',
      content: { 'application/json': { schema: PageNotFoundErrorSchema } },
    },
    422: {
      description: 'HTML artifact delivery is not configured on this server',
      content: { 'application/json': { schema: ArtifactUrlUnavailableErrorSchema } },
    },
    500: {
      description: 'Internal server error',
      content: { 'application/json': { schema: InternalServerErrorSchema } },
    },
  },
});

export const artifactRoutes = { mintArtifactUrlRoute };
