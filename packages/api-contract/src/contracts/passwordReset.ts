/**
 * Public self-service password-reset routes.
 *
 *   POST /auth/forgot-password — email a reset link (always 200)
 *   GET  /auth/reset-password?token= — validate token for the page
 *   POST /auth/reset-password  — set new password; returns login tokens
 *
 * All public: the signed reset token is the credential.
 */
import { createRoute } from '@hono/zod-openapi';

import { TokenAuthResponseSchema } from '../schemas/auth';
import { ApiErrorSchema, InternalServerErrorSchema } from '../schemas/common';
import { ForgotPasswordRequestSchema, ForgotPasswordResponseSchema, ResetPasswordRequestSchema } from '../schemas/passwordReset';

export const forgotPasswordRoute = createRoute({
  method: 'post',
  path: '/auth/forgot-password',
  tags: ['passwordReset'],
  summary: 'Request a password-reset link by email (always succeeds)',
  request: {
    body: {
      content: { 'application/json': { schema: ForgotPasswordRequestSchema } },
    },
  },
  responses: {
    200: {
      description: 'Accepted (a link is sent if the email maps to an active account)',
      content: { 'application/json': { schema: ForgotPasswordResponseSchema } },
    },
    400: {
      description: 'Validation failed',
      content: { 'application/json': { schema: ApiErrorSchema } },
    },
    500: {
      description: 'Internal server error',
      content: { 'application/json': { schema: InternalServerErrorSchema } },
    },
  },
});

export const validateResetTokenRoute = createRoute({
  method: 'get',
  path: '/auth/reset-password',
  tags: ['passwordReset'],
  summary: 'Validate a password-reset token (page preflight)',
  request: {
    query: ResetPasswordRequestSchema.pick({ token: true }),
  },
  responses: {
    200: {
      description: 'Token is valid',
      content: { 'application/json': { schema: ForgotPasswordResponseSchema } },
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

export const selfResetPasswordRoute = createRoute({
  method: 'post',
  path: '/auth/reset-password',
  tags: ['passwordReset'],
  summary: 'Set a new password with a reset token; signs the user in',
  request: {
    body: {
      content: { 'application/json': { schema: ResetPasswordRequestSchema } },
    },
  },
  responses: {
    200: {
      description: 'Password updated; signed in',
      content: { 'application/json': { schema: TokenAuthResponseSchema } },
    },
    400: {
      description: 'Validation failed',
      content: { 'application/json': { schema: ApiErrorSchema } },
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

export const passwordResetRoutes = {
  forgotPasswordRoute,
  validateResetTokenRoute,
  selfResetPasswordRoute,
};
