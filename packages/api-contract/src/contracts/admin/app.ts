/**
 * RFC-0006 Phase 4 Batch 9 — `admin.app` sub-contract ported to
 * `@hono/zod-openapi` route definitions.
 *
 *   GET  /admin/app   — read the current `app:*` slice (plus derived fields)
 *   PUT  /admin/app   — partial update of the `app:*` slice
 *
 * Auth + install:
 *   - Both endpoints sit under `/admin/app` and are admin-only. The
 *     handler installs `createJwtAdminRequired(crowi)` on the path itself
 *     (broad apply with `/admin/app/*` covers any future nested route
 *     and a literal `/admin/app` apply covers the bare path).
 *
 * Validation envelope:
 *   - The PUT route emits the custom `AppSettingsValidationErrorSchema`
 *     `{ bodyResult: { issues, name } }` shape on body validation
 *     failure instead of the global `ValidationErrorSchema`. The route
 *     declares an inline `hook` that overrides the OpenAPIHono
 *     `defaultHook` for this single route (RFC open question 5).
 */
import { createRoute } from '@hono/zod-openapi';
import type { Context } from 'hono';
import type { ZodError } from 'zod';

import {
  AppSettingsValidationErrorSchema,
  GetAppSettingsResponseSchema,
  UpdateAppSettingsRequestSchema,
  UpdateAppSettingsResponseSchema,
} from '../../schemas/admin/app';
import { AdminRequiredErrorSchema, AuthenticationRequiredErrorSchema, InternalServerErrorSchema } from '../../schemas/common';

/**
 * Per-route validation hook: emit the `AppSettingsValidationErrorSchema`
 * `{ bodyResult: { issues, name } }` envelope on body parse failure
 * (legacy wire-shape preserved).
 */
const appSettingsValidationHook = (result: { success: boolean; error?: ZodError }, c: Context): Response | undefined => {
  if (result.success) return;
  const issues = (result.error?.issues ?? []).map((i) => ({
    path: i.path.map((p): string | number => (typeof p === 'symbol' ? String(p) : p)),
    message: i.message,
  }));
  return c.json(
    {
      bodyResult: {
        issues,
        name: 'ZodError',
      },
    },
    400,
  );
};

export const getAppSettingsRoute = createRoute({
  method: 'get',
  path: '/admin/app',
  tags: ['admin.app'],
  security: [{ bearerAuth: [] }],
  summary: 'Read the current App settings (incl. AWS upload section)',
  responses: {
    200: {
      description: 'Current `app:*` slice plus derived read-only fields',
      content: { 'application/json': { schema: GetAppSettingsResponseSchema } },
    },
    401: {
      description: 'Authentication required',
      content: { 'application/json': { schema: AuthenticationRequiredErrorSchema } },
    },
    403: {
      description: 'Admin permission required',
      content: { 'application/json': { schema: AdminRequiredErrorSchema } },
    },
  },
});

export const updateAppSettingsRoute = createRoute({
  method: 'put',
  path: '/admin/app',
  tags: ['admin.app'],
  security: [{ bearerAuth: [] }],
  summary: 'Update App settings — partial updates per section',
  hook: appSettingsValidationHook,
  request: {
    body: {
      content: { 'application/json': { schema: UpdateAppSettingsRequestSchema } },
    },
  },
  responses: {
    200: {
      description: 'Update succeeded',
      content: { 'application/json': { schema: UpdateAppSettingsResponseSchema } },
    },
    400: {
      description: 'Body validation failed (legacy `{ bodyResult }` envelope)',
      content: { 'application/json': { schema: AppSettingsValidationErrorSchema } },
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

export const adminAppRoutes = {
  getAppSettingsRoute,
  updateAppSettingsRoute,
};

// Re-export types so existing consumers keep compiling.
export type {
  AppSettingsValidationError,
  GetAppSettingsResponse,
  UpdateAppSettingsRequest,
  UpdateAppSettingsResponse,
} from '../../schemas/admin/app';
