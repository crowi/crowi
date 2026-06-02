/**
 * RFC-0006 Phase 4 Batch 9 — `admin.security` sub-contract ported to
 * `@hono/zod-openapi` route definitions.
 *
 *   GET /admin/security  — read the four `security:*` keys
 *   PUT /admin/security  — persist them
 *
 * Auth + install:
 *   - The handler installs `createJwtAdminRequired(crowi)` broadly on
 *     `/admin/security/*` plus the bare `/admin/security` path.
 */
import { createRoute } from '@hono/zod-openapi';

import { GetSecuritySettingsResponseSchema, UpdateSecuritySettingsRequestSchema, UpdateSecuritySettingsResponseSchema } from '../../schemas/admin/security';
import { AdminRequiredErrorSchema, AuthenticationRequiredErrorSchema, InternalServerErrorSchema } from '../../schemas/common';

export const getSecuritySettingsRoute = createRoute({
  method: 'get',
  path: '/admin/security',
  tags: ['admin.security'],
  security: [{ bearerAuth: [] }],
  summary: 'Get the current security:* settings',
  responses: {
    200: {
      description: 'Current security settings',
      content: { 'application/json': { schema: GetSecuritySettingsResponseSchema } },
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

export const updateSecuritySettingsRoute = createRoute({
  method: 'put',
  path: '/admin/security',
  tags: ['admin.security'],
  security: [{ bearerAuth: [] }],
  summary: 'Update security:* settings (registrationMode / registrationWhiteList)',
  request: {
    body: {
      content: { 'application/json': { schema: UpdateSecuritySettingsRequestSchema } },
    },
  },
  responses: {
    200: {
      description: 'Updated settings (re-read from in-memory cache)',
      content: { 'application/json': { schema: UpdateSecuritySettingsResponseSchema } },
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

export const adminSecurityRoutes = {
  getSecuritySettingsRoute,
  updateSecuritySettingsRoute,
};

export type {
  GetSecuritySettingsResponse,
  RegistrationMode,
  SecuritySettings,
  UpdateSecuritySettingsRequest,
  UpdateSecuritySettingsResponse,
} from '../../schemas/admin/security';
