/**
 * Public account-activation (email confirmation) routes.
 *
 *   GET  /auth/activate?token= — validate token for the page preflight
 *   POST /auth/activate        — confirm email, activate, sign in
 *
 * Public: the signed activation token is the credential.
 */
import { createRoute } from '@hono/zod-openapi';

import { ActivateRequestSchema, ActivateValidationResponseSchema } from '../schemas/activation';
import { TokenAuthResponseSchema } from '../schemas/auth';
import { ApiErrorSchema, InternalServerErrorSchema } from '../schemas/common';

export const validateActivationTokenRoute = createRoute({
  method: 'get',
  path: '/auth/activate',
  tags: ['activation'],
  summary: 'Validate an activation token (page preflight)',
  request: {
    query: ActivateRequestSchema.pick({ token: true }),
  },
  responses: {
    200: {
      description: 'Token is valid',
      content: { 'application/json': { schema: ActivateValidationResponseSchema } },
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

export const activateAccountRoute = createRoute({
  method: 'post',
  path: '/auth/activate',
  tags: ['activation'],
  summary: 'Confirm email with an activation token; activates and signs in',
  request: {
    body: {
      content: { 'application/json': { schema: ActivateRequestSchema } },
    },
  },
  responses: {
    200: {
      description: 'Email confirmed; account activated and signed in',
      content: { 'application/json': { schema: TokenAuthResponseSchema } },
    },
    401: {
      description: 'Token is invalid or expired',
      content: { 'application/json': { schema: ApiErrorSchema } },
    },
    404: {
      description: 'Associated user no longer exists',
      content: { 'application/json': { schema: ApiErrorSchema } },
    },
    500: {
      description: 'Internal server error',
      content: { 'application/json': { schema: InternalServerErrorSchema } },
    },
  },
});

export const activationRoutes = {
  validateActivationTokenRoute,
  activateAccountRoute,
};
