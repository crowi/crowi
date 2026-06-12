/**
 * RFC-0006 Phase 4 Batch 9 — `admin.auth` sub-contract ported to
 * `@hono/zod-openapi` route definitions.
 *
 *   GET /admin/auth   — read the two inert `auth:*` settings
 *   PUT /admin/auth   — persist them (both toggles are always rejected)
 *
 * Auth + install:
 *   - The handler installs `createJwtAdminRequired(crowi)` broadly on
 *     `/admin/auth/*` plus the bare `/admin/auth` path.
 *
 * 400 wire shape:
 *   - Third-party sign-in was removed from core in the 2.0.0-alpha line, so
 *     enabling either `requireThirdPartyAuth` or `disablePasswordAuth` is hard-
 *     rejected with a 400 `THIRD_PARTY_AUTH_UNAVAILABLE` envelope. The toggles
 *     and config keys are kept (inert) for a future auth provider plugin.
 */
import { createRoute } from '@hono/zod-openapi';

import {
  GetAuthSettingsResponseSchema,
  ThirdPartyAuthUnavailableErrorSchema,
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
    400: {
      description:
        'Enabling a third-party-dependent setting (requireThirdPartyAuth / disablePasswordAuth) is rejected because third-party sign-in was removed from core',
      content: { 'application/json': { schema: ThirdPartyAuthUnavailableErrorSchema } },
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

export const adminAuthRoutes = {
  getAuthSettingsRoute,
  updateAuthSettingsRoute,
};

export type {
  AuthSettings,
  GetAuthSettingsResponse,
  ThirdPartyAuthUnavailableError,
  UpdateAuthSettingsRequest,
  UpdateAuthSettingsResponse,
} from '../../schemas/admin/auth';
