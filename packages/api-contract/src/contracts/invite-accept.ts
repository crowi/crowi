/**
 * Public invite-acceptance routes.
 *
 *   GET  /invite/accept?token=  — preview the invited email (page header)
 *   POST /invite/accept         — set username/name/password, activate,
 *                                 and return login tokens
 *
 * Both are public (no JWT): the signed invite token is the credential.
 */
import { createRoute } from '@hono/zod-openapi';

import { TokenAuthResponseSchema } from '../schemas/auth';
import { ApiErrorSchema, InternalServerErrorSchema } from '../schemas/common';
import { InviteAcceptRequestSchema, InvitePreviewResponseSchema } from '../schemas/invite-accept';

export const invitePreviewRoute = createRoute({
  method: 'get',
  path: '/invite/accept',
  tags: ['inviteAccept'],
  summary: 'Preview an invite (returns the invited email) for the acceptance page',
  request: {
    query: InviteAcceptRequestSchema.pick({ token: true }),
  },
  responses: {
    200: {
      description: 'Invite is valid',
      content: { 'application/json': { schema: InvitePreviewResponseSchema } },
    },
    401: {
      description: 'Invite token is invalid or expired',
      content: { 'application/json': { schema: ApiErrorSchema } },
    },
    409: {
      description: 'Invite already accepted',
      content: { 'application/json': { schema: ApiErrorSchema } },
    },
    500: {
      description: 'Internal server error',
      content: { 'application/json': { schema: InternalServerErrorSchema } },
    },
  },
});

export const acceptInviteRoute = createRoute({
  method: 'post',
  path: '/invite/accept',
  tags: ['inviteAccept'],
  summary: 'Accept an invite: set credentials, activate the account, sign in',
  request: {
    body: {
      content: { 'application/json': { schema: InviteAcceptRequestSchema } },
    },
  },
  responses: {
    200: {
      description: 'Invite accepted; account activated and signed in',
      content: { 'application/json': { schema: TokenAuthResponseSchema } },
    },
    400: {
      description: 'Validation failed',
      content: { 'application/json': { schema: ApiErrorSchema } },
    },
    401: {
      description: 'Invite token is invalid or expired',
      content: { 'application/json': { schema: ApiErrorSchema } },
    },
    404: {
      description: 'Invited user no longer exists',
      content: { 'application/json': { schema: ApiErrorSchema } },
    },
    409: {
      description: 'Invite already accepted, or username already taken',
      content: { 'application/json': { schema: ApiErrorSchema } },
    },
    500: {
      description: 'Internal server error',
      content: { 'application/json': { schema: InternalServerErrorSchema } },
    },
  },
});

export const inviteAcceptRoutes = {
  invitePreviewRoute,
  acceptInviteRoute,
};
