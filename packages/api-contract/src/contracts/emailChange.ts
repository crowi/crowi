/**
 * Public email-change confirmation routes.
 *
 *   GET  /auth/confirm-email-change?token= — preflight (token valid?)
 *   POST /auth/confirm-email-change        — apply the new email address
 *
 * Public: the signed (purpose='email-change') token is the credential.
 */
import { createRoute } from '@hono/zod-openapi';

import { ApiErrorSchema, InternalServerErrorSchema } from '../schemas/common';
import { ConfirmEmailChangeRequestSchema, ConfirmEmailChangeResponseSchema } from '../schemas/emailChange';

export const validateEmailChangeTokenRoute = createRoute({
  method: 'get',
  path: '/auth/confirm-email-change',
  tags: ['emailChange'],
  summary: 'Validate an email-change token (page preflight)',
  request: {
    query: ConfirmEmailChangeRequestSchema.pick({ token: true }),
  },
  responses: {
    200: {
      description: 'Token is valid',
      content: { 'application/json': { schema: ConfirmEmailChangeResponseSchema } },
    },
    401: {
      description: 'Token is invalid or expired',
      content: { 'application/json': { schema: ApiErrorSchema } },
    },
    500: {
      description: 'Internal server error',
      content: { 'application/json': { schema: InternalServerErrorSchema } },
    },
  },
});

export const confirmEmailChangeRoute = createRoute({
  method: 'post',
  path: '/auth/confirm-email-change',
  tags: ['emailChange'],
  summary: 'Apply a confirmed email-address change',
  request: {
    body: {
      content: { 'application/json': { schema: ConfirmEmailChangeRequestSchema } },
    },
  },
  responses: {
    200: {
      description: 'Email address updated',
      content: { 'application/json': { schema: ConfirmEmailChangeResponseSchema } },
    },
    401: {
      description: 'Token is invalid or expired',
      content: { 'application/json': { schema: ApiErrorSchema } },
    },
    404: {
      description: 'Associated user no longer exists',
      content: { 'application/json': { schema: ApiErrorSchema } },
    },
    409: {
      description: 'The new email address is already in use',
      content: { 'application/json': { schema: ApiErrorSchema } },
    },
    500: {
      description: 'Internal server error',
      content: { 'application/json': { schema: InternalServerErrorSchema } },
    },
  },
});

export const emailChangeRoutes = {
  validateEmailChangeTokenRoute,
  confirmEmailChangeRoute,
};
