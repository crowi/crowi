/**
 * Self-service OAuth session (refresh-token rotation-chain tip) list + revoke, under the `/me/*` prefix (rides the existing broad `createJwtAuth` pattern — see `contracts/access-token.ts`).
 *
 * **Web-session only**, like PAT management: an active user's PAT or OAuth bearer is rejected with 403 `FORBIDDEN` (no privilege escalation from a token managing OAuth credentials). Unlike PAT management, the 403 union also carries `UserStatusErrorSchema` — `createJwtAuth` itself returns `USER_REGISTERED` / `USER_SUSPENDED` / `USER_INVITED` (403) for a valid-but-inactive credential before the handler runs, and this contract documents that shared middleware boundary explicitly.
 */
import { createRoute, z } from '@hono/zod-openapi';

import { ListOAuthSessionsResponseSchema, OAuthSessionSchema } from '../schemas/oauth-session';
import {
  AuthenticationRequiredErrorSchema,
  ForbiddenErrorSchema,
  InternalServerErrorSchema,
  NotFoundErrorSchema,
  UserStatusErrorSchema,
} from '../schemas/common';

const ForbiddenOrUserStatusSchema = z.union([ForbiddenErrorSchema, UserStatusErrorSchema]);

export const listOAuthSessionsRoute = createRoute({
  method: 'get',
  path: '/me/oauth-sessions',
  tags: ['me'],
  security: [{ bearerAuth: [] }],
  summary: "List the current user's active OAuth sessions (refresh-token rotation-chain tips)",
  responses: {
    200: {
      description: 'Active OAuth session list (no secrets)',
      content: { 'application/json': { schema: ListOAuthSessionsResponseSchema } },
    },
    401: {
      description: 'Authentication required',
      content: { 'application/json': { schema: AuthenticationRequiredErrorSchema } },
    },
    403: {
      description: 'OAuth sessions can only be managed from a web session, or the account is not active',
      content: { 'application/json': { schema: ForbiddenOrUserStatusSchema } },
    },
    500: {
      description: 'Internal server error',
      content: { 'application/json': { schema: InternalServerErrorSchema } },
    },
  },
});

export const deleteOAuthSessionRoute = createRoute({
  method: 'delete',
  path: '/me/oauth-sessions/{id}',
  tags: ['me'],
  security: [{ bearerAuth: [] }],
  summary: 'Revoke an OAuth session (the rotation-chain component reachable from this tip)',
  request: {
    params: z.object({ id: z.string() }),
  },
  responses: {
    200: {
      description: 'Session revoked',
      content: { 'application/json': { schema: OAuthSessionSchema } },
    },
    401: {
      description: 'Authentication required',
      content: { 'application/json': { schema: AuthenticationRequiredErrorSchema } },
    },
    403: {
      description: 'OAuth sessions can only be managed from a web session, or the account is not active',
      content: { 'application/json': { schema: ForbiddenOrUserStatusSchema } },
    },
    404: {
      description: 'No such session belonging to the current user',
      content: { 'application/json': { schema: NotFoundErrorSchema } },
    },
    500: {
      description: 'Internal server error',
      content: { 'application/json': { schema: InternalServerErrorSchema } },
    },
  },
});

export const oauthSessionRoutes = {
  listOAuthSessionsRoute,
  deleteOAuthSessionRoute,
};
