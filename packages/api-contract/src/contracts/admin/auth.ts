/**
 * RFC-0006 Phase 4 Batch 9 — `admin.auth` sub-contract ported to
 * `@hono/zod-openapi` route definitions.
 *
 *   GET /admin/auth   — read the two `auth:*` settings
 *   PUT /admin/auth   — persist them (with self-lockout 422 guard)
 *
 * Auth + install:
 *   - The handler installs `createJwtAdminRequired(crowi)` broadly on
 *     `/admin/auth/*` plus the bare `/admin/auth` path.
 *
 * 422 wire shape:
 *   - The legacy self-lockout guard (`disablePasswordAuth: true` without a
 *     valid third-party identity) maps to a 422 envelope carrying the
 *     `PASSWORD_AUTH_REQUIRES_THIRDPARTY` discriminator — preserved verbatim.
 */
import { createRoute } from '@hono/zod-openapi';

import {
  AuthSettingsValidationErrorSchema,
  GetAuthSettingsResponseSchema,
  UpdateAuthSettingsRequestSchema,
  UpdateAuthSettingsResponseSchema,
} from '../../schemas/admin/auth';
import { AdminRequiredErrorSchema, AuthenticationRequiredErrorSchema, InternalServerErrorSchema } from '../../schemas/common';

export const getAuthSettingsRoute = createRoute({
  method: 'get',
  path: '/admin/auth',
  tags: ['admin.auth'],
  security: [{ bearerAuth: [] }],
  summary: 'Get the current auth:* settings',
  responses: {
    200: {
      description: 'Current authentication settings',
      content: { 'application/json': { schema: GetAuthSettingsResponseSchema } },
    },
    401: {
      description: 'Authentication required',
      content: { 'application/json': { schema: AuthenticationRequiredErrorSchema } },
    },
    403: {
      description: 'Admin permission required',
      content: { 'application/json': { schema: AdminRequiredErrorSchema } },
    },
    500: {
      description: 'Internal server error',
      content: { 'application/json': { schema: InternalServerErrorSchema } },
    },
  },
});

export const updateAuthSettingsRoute = createRoute({
  method: 'put',
  path: '/admin/auth',
  tags: ['admin.auth'],
  security: [{ bearerAuth: [] }],
  summary: 'Update auth:* settings (requireThirdPartyAuth / disablePasswordAuth)',
  request: {
    body: {
      content: { 'application/json': { schema: UpdateAuthSettingsRequestSchema } },
    },
  },
  responses: {
    200: {
      description: 'Updated settings (re-read from in-memory cache)',
      content: { 'application/json': { schema: UpdateAuthSettingsResponseSchema } },
    },
    401: {
      description: 'Authentication required',
      content: { 'application/json': { schema: AuthenticationRequiredErrorSchema } },
    },
    403: {
      description: 'Admin permission required',
      content: { 'application/json': { schema: AdminRequiredErrorSchema } },
    },
    422: {
      description: 'Self-lockout guard rejected the request',
      content: { 'application/json': { schema: AuthSettingsValidationErrorSchema } },
    },
    500: {
      description: 'Internal server error',
      content: { 'application/json': { schema: InternalServerErrorSchema } },
    },
  },
});

export const adminAuthRoutes = {
  getAuthSettingsRoute,
  updateAuthSettingsRoute,
};

export type {
  AuthSettings,
  AuthSettingsValidationError,
  GetAuthSettingsResponse,
  UpdateAuthSettingsRequest,
  UpdateAuthSettingsResponse,
} from '../../schemas/admin/auth';
