/**
 * RFC-0006 Phase 4 Batch 9 — `admin.share` sub-contract ported to
 * `@hono/zod-openapi` route definitions.
 *
 *   GET /admin/share  — read the single `app:externalShare` toggle
 *   PUT /admin/share  — persist it
 *
 * Auth + install:
 *   - The handler installs `createJwtAdminRequired(crowi)` broadly on
 *     `/admin/share/*` plus the bare `/admin/share` path.
 */
import { createRoute } from '@hono/zod-openapi';

import { GetShareSettingsResponseSchema, UpdateShareSettingsRequestSchema, UpdateShareSettingsResponseSchema } from '../../schemas/admin/share';
import { AdminRequiredErrorSchema, AuthenticationRequiredErrorSchema, InternalServerErrorSchema } from '../../schemas/common';

export const getShareSettingsRoute = createRoute({
  method: 'get',
  path: '/admin/share',
  tags: ['admin.share'],
  security: [{ bearerAuth: [] }],
  summary: 'Get the current share settings (externalShare toggle)',
  responses: {
    200: {
      description: 'Current share settings',
      content: { 'application/json': { schema: GetShareSettingsResponseSchema } },
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

export const updateShareSettingsRoute = createRoute({
  method: 'put',
  path: '/admin/share',
  tags: ['admin.share'],
  security: [{ bearerAuth: [] }],
  summary: 'Toggle external sharing on/off (persists `app:externalShare`)',
  request: {
    body: {
      content: { 'application/json': { schema: UpdateShareSettingsRequestSchema } },
    },
  },
  responses: {
    200: {
      description: 'Updated settings (re-read from in-memory cache)',
      content: { 'application/json': { schema: UpdateShareSettingsResponseSchema } },
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

export const adminShareRoutes = {
  getShareSettingsRoute,
  updateShareSettingsRoute,
};

export type {
  GetShareSettingsResponse,
  ShareSettings,
  UpdateShareSettingsRequest,
  UpdateShareSettingsResponse,
} from '../../schemas/admin/share';
