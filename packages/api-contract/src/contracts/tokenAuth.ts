/**
 * RFC-0006 Phase 4 (Batch 1) — `tokenAuth` resource ported to
 * `@hono/zod-openapi` route definitions. Five endpoints:
 *
 *   POST /auth/login    — public, returns access/refresh tokens
 *   POST /auth/register — public, returns access/refresh tokens
 *   POST /auth/refresh  — public, exchanges a refresh token for new tokens
 *   POST /auth/logout   — auth required (server-side is stateless; the
 *                          client discards tokens — this is just an ACK)
 *   GET  /auth/me       — auth required, returns the current user
 *
 * The legacy ts-rest contract declared `authorization` as a required
 * request header on `tokenLogout` / `tokenMe`. We drop that here: the
 * `createJwtAuth` middleware reads `Authorization: Bearer ...` (or the
 * `crowi.accessToken` cookie fallback) before the handler runs, so the
 * header is not a route-level input.
 */
import { createRoute, z } from '@hono/zod-openapi';

import { RefreshTokenRequestSchema, TokenAuthLoginRequestSchema, TokenAuthRegisterRequestSchema, TokenAuthResponseSchema } from '../schemas/auth';
import { ApiErrorSchema, ApplicationNotInstalledErrorSchema, AuthenticationRequiredErrorSchema, InternalServerErrorSchema } from '../schemas/common';

const TokenLogoutResponseSchema = z.object({ message: z.string() });

const TokenMeResponseSchema = z.object({
  user: z.object({
    id: z.string(),
    username: z.string(),
    email: z.string().email(),
    name: z.string(),
    image: z.string().optional(),
    status: z.number(),
    admin: z.boolean().optional(),
    createdAt: z.string(),
  }),
});

export const tokenLoginRoute = createRoute({
  method: 'post',
  path: '/auth/login',
  tags: ['tokenAuth'],
  summary: 'Authenticate user and receive tokens',
  request: {
    body: {
      content: {
        'application/json': {
          schema: TokenAuthLoginRequestSchema,
        },
      },
    },
  },
  responses: {
    200: {
      description: 'Successful login',
      content: { 'application/json': { schema: TokenAuthResponseSchema } },
    },
    401: {
      description: 'Invalid email or password',
      content: { 'application/json': { schema: ApiErrorSchema } },
    },
    403: {
      description: 'User account is not active',
      content: { 'application/json': { schema: ApiErrorSchema } },
    },
    500: {
      description: 'Internal server error',
      content: { 'application/json': { schema: InternalServerErrorSchema } },
    },
    503: {
      description: 'Application is not installed',
      content: { 'application/json': { schema: ApplicationNotInstalledErrorSchema } },
    },
  },
});

export const tokenRegisterRoute = createRoute({
  method: 'post',
  path: '/auth/register',
  tags: ['tokenAuth'],
  summary: 'Register new user and receive tokens',
  request: {
    body: {
      content: {
        'application/json': {
          schema: TokenAuthRegisterRequestSchema,
        },
      },
    },
  },
  responses: {
    201: {
      description: 'Successful registration',
      content: { 'application/json': { schema: TokenAuthResponseSchema } },
    },
    400: {
      description: 'Registration failed (validation)',
      content: { 'application/json': { schema: ApiErrorSchema } },
    },
    403: {
      description: 'Registration is closed by the admin',
      content: { 'application/json': { schema: ApiErrorSchema } },
    },
    409: {
      description: 'User with the same email or username already exists',
      content: { 'application/json': { schema: ApiErrorSchema } },
    },
    500: {
      description: 'Internal server error',
      content: { 'application/json': { schema: InternalServerErrorSchema } },
    },
    503: {
      description: 'Application is not installed',
      content: { 'application/json': { schema: ApplicationNotInstalledErrorSchema } },
    },
  },
});

export const tokenRefreshRoute = createRoute({
  method: 'post',
  path: '/auth/refresh',
  tags: ['tokenAuth'],
  summary: 'Refresh access token using refresh token',
  request: {
    body: {
      content: {
        'application/json': {
          schema: RefreshTokenRequestSchema,
        },
      },
    },
  },
  responses: {
    200: {
      description: 'Refreshed tokens',
      content: { 'application/json': { schema: TokenAuthResponseSchema } },
    },
    400: {
      description: 'Missing refresh token',
      content: { 'application/json': { schema: ApiErrorSchema } },
    },
    401: {
      description: 'Invalid or expired refresh token',
      content: { 'application/json': { schema: AuthenticationRequiredErrorSchema } },
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

export const tokenLogoutRoute = createRoute({
  method: 'post',
  path: '/auth/logout',
  tags: ['tokenAuth'],
  security: [{ bearerAuth: [] }],
  summary: 'Logout user and invalidate tokens',
  request: {
    body: {
      content: {
        'application/json': {
          schema: z.object({ refreshToken: z.string().optional() }),
        },
      },
    },
  },
  responses: {
    200: {
      description: 'Logged out successfully',
      content: { 'application/json': { schema: TokenLogoutResponseSchema } },
    },
    401: {
      description: 'Authentication required',
      content: { 'application/json': { schema: AuthenticationRequiredErrorSchema } },
    },
    500: {
      description: 'Internal server error',
      content: { 'application/json': { schema: InternalServerErrorSchema } },
    },
  },
});

export const tokenMeRoute = createRoute({
  method: 'get',
  path: '/auth/me',
  tags: ['tokenAuth'],
  security: [{ bearerAuth: [] }],
  summary: 'Get current user information',
  responses: {
    200: {
      description: 'Current user',
      content: { 'application/json': { schema: TokenMeResponseSchema } },
    },
    401: {
      description: 'Authentication required',
      content: { 'application/json': { schema: AuthenticationRequiredErrorSchema } },
    },
    500: {
      description: 'Internal server error',
      content: { 'application/json': { schema: InternalServerErrorSchema } },
    },
  },
});

export const tokenAuthRoutes = {
  tokenLoginRoute,
  tokenRegisterRoute,
  tokenRefreshRoute,
  tokenLogoutRoute,
  tokenMeRoute,
};
