/**
 * RFC-0010 §Endpoints — Personal Access Token (PAT) management contracts.
 *
 * Replaces the legacy `GET/POST /me/apiToken` pair. Three endpoints under
 * the `/me/*` prefix (so they ride the existing broad `createJwtAuth`):
 *
 *   GET    /me/access-tokens       — list metadata (never the secret)
 *   POST   /me/access-tokens       — issue a PAT; returns plaintext once
 *   DELETE /me/access-tokens/:id   — revoke a PAT
 *
 * RFC-0010 §Security: these endpoints are **web-session only**. A PAT or
 * OAuth token presenting itself here is rejected with 403 `FORBIDDEN` to
 * prevent a leaked token from minting fresh, longer-lived tokens.
 */
import { createRoute, z } from '@hono/zod-openapi';

import {
  AccessTokenSchema,
  CreateAccessTokenRequestSchema,
  CreateAccessTokenResponseSchema,
  InvalidScopeErrorSchema,
  ListAccessTokensResponseSchema,
} from '../schemas/access-token';
import { AuthenticationRequiredErrorSchema, ForbiddenErrorSchema, InternalServerErrorSchema, NotFoundErrorSchema } from '../schemas/common';

export const listAccessTokensRoute = createRoute({
  method: 'get',
  path: '/me/access-tokens',
  tags: ['me'],
  security: [{ bearerAuth: [] }],
  summary: "List the current user's personal access tokens (metadata only)",
  responses: {
    200: {
      description: 'Personal access token list (no secrets)',
      content: { 'application/json': { schema: ListAccessTokensResponseSchema } },
    },
    401: {
      description: 'Authentication required',
      content: { 'application/json': { schema: AuthenticationRequiredErrorSchema } },
    },
    403: {
      description: 'Personal access tokens can only be managed from a web session',
      content: { 'application/json': { schema: ForbiddenErrorSchema } },
    },
    500: {
      description: 'Internal server error',
      content: { 'application/json': { schema: InternalServerErrorSchema } },
    },
  },
});

export const createAccessTokenRoute = createRoute({
  method: 'post',
  path: '/me/access-tokens',
  tags: ['me'],
  security: [{ bearerAuth: [] }],
  summary: 'Issue a personal access token (plaintext returned once)',
  request: {
    body: {
      content: { 'application/json': { schema: CreateAccessTokenRequestSchema } },
    },
  },
  responses: {
    201: {
      description: 'Token issued; `token` holds the one-time plaintext secret',
      content: { 'application/json': { schema: CreateAccessTokenResponseSchema } },
    },
    400: {
      description: 'One or more requested scopes are not issuable',
      content: { 'application/json': { schema: InvalidScopeErrorSchema } },
    },
    401: {
      description: 'Authentication required',
      content: { 'application/json': { schema: AuthenticationRequiredErrorSchema } },
    },
    403: {
      description: 'Personal access tokens can only be managed from a web session',
      content: { 'application/json': { schema: ForbiddenErrorSchema } },
    },
    500: {
      description: 'Internal server error',
      content: { 'application/json': { schema: InternalServerErrorSchema } },
    },
  },
});

export const deleteAccessTokenRoute = createRoute({
  method: 'delete',
  path: '/me/access-tokens/{id}',
  tags: ['me'],
  security: [{ bearerAuth: [] }],
  summary: 'Revoke a personal access token',
  request: {
    params: z.object({ id: z.string() }),
  },
  responses: {
    200: {
      description: 'Token revoked',
      content: { 'application/json': { schema: AccessTokenSchema } },
    },
    401: {
      description: 'Authentication required',
      content: { 'application/json': { schema: AuthenticationRequiredErrorSchema } },
    },
    403: {
      description: 'Personal access tokens can only be managed from a web session',
      content: { 'application/json': { schema: ForbiddenErrorSchema } },
    },
    404: {
      description: 'No such token belonging to the current user',
      content: { 'application/json': { schema: NotFoundErrorSchema } },
    },
    500: {
      description: 'Internal server error',
      content: { 'application/json': { schema: InternalServerErrorSchema } },
    },
  },
});

export const accessTokenRoutes = {
  listAccessTokensRoute,
  createAccessTokenRoute,
  deleteAccessTokenRoute,
};
