/**
 * RFC-0006 Phase 4 Batch 9 — `admin.plugins` sub-contract ported to
 * `@hono/zod-openapi` route definitions.
 *
 * 6 endpoints:
 *   GET  /admin/plugins                              (listPlugins)
 *   GET  /admin/plugins/config?name=…                (getPluginConfig)
 *   PUT  /admin/plugins/config?name=…                (updatePluginConfig)
 *   GET  /admin/plugins/readiness                    (getPluginReadiness — feature-plugin-config-readiness)
 *   POST /admin/plugins/render-cache/clear-all       (clearRenderCacheAll)
 *   POST /admin/plugins/render-cache/clear-plugin?name=…  (clearRenderCachePlugin)
 *
 * Auth + install:
 *   - The handler installs `createJwtAdminRequired(crowi)` broadly on
 *     `/admin/plugins/*` plus the bare `/admin/plugins` path.
 *
 * Plugin npm names contain a `/` (e.g. `@crowi/plugin-storage-local`)
 * which collides with the Hono router's path-segment matching, so the
 * name is passed as a query string rather than a path parameter.
 */
import { createRoute, z } from '@hono/zod-openapi';

import {
  ClearRenderCacheResponseSchema,
  ConfigReadinessResponseSchema,
  ListPluginsResponseSchema,
  PluginConfigResponseSchema,
  PluginConfigValidationErrorSchema,
  PluginNotFoundErrorSchema,
  UpdatePluginConfigRequestSchema,
  UpdatePluginConfigResponseSchema,
} from '../../schemas/admin/plugins';
import { AdminRequiredErrorSchema, AuthenticationRequiredErrorSchema, InternalServerErrorSchema } from '../../schemas/common';

const PluginNameQuerySchema = z.object({ name: z.string() });
// getPluginConfig also accepts an optional `locale` so the API can overlay
// the plugin's `configI18n[locale]` field label/description translations.
const PluginConfigQuerySchema = z.object({ name: z.string(), locale: z.string().optional() });

export const listPluginsRoute = createRoute({
  method: 'get',
  path: '/admin/plugins',
  tags: ['admin.plugins'],
  security: [{ bearerAuth: [] }],
  summary: 'List every plugin currently loaded',
  responses: {
    200: {
      description: 'Plugin list with declared registry slots',
      content: { 'application/json': { schema: ListPluginsResponseSchema } },
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

export const getPluginConfigRoute = createRoute({
  method: 'get',
  path: '/admin/plugins/config',
  tags: ['admin.plugins'],
  security: [{ bearerAuth: [] }],
  summary: 'Get a plugin config form schema + current values',
  request: {
    query: PluginConfigQuerySchema,
  },
  responses: {
    200: {
      description: 'Plugin config + values (secrets masked)',
      content: { 'application/json': { schema: PluginConfigResponseSchema } },
    },
    401: {
      description: 'Authentication required',
      content: { 'application/json': { schema: AuthenticationRequiredErrorSchema } },
    },
    403: {
      description: 'Admin permission required',
      content: { 'application/json': { schema: AdminRequiredErrorSchema } },
    },
    404: {
      description: 'Plugin not loaded',
      content: { 'application/json': { schema: PluginNotFoundErrorSchema } },
    },
    500: {
      description: 'Internal server error',
      content: { 'application/json': { schema: InternalServerErrorSchema } },
    },
  },
});

export const updatePluginConfigRoute = createRoute({
  method: 'put',
  path: '/admin/plugins/config',
  tags: ['admin.plugins'],
  security: [{ bearerAuth: [] }],
  summary: 'Update a plugin config (per-field validation via plugin Zod schema)',
  request: {
    query: PluginNameQuerySchema,
    body: {
      content: { 'application/json': { schema: UpdatePluginConfigRequestSchema } },
    },
  },
  responses: {
    200: {
      description: 'Save succeeded; hotReloaded flag indicates live apply',
      content: { 'application/json': { schema: UpdatePluginConfigResponseSchema } },
    },
    401: {
      description: 'Authentication required',
      content: { 'application/json': { schema: AuthenticationRequiredErrorSchema } },
    },
    403: {
      description: 'Admin permission required',
      content: { 'application/json': { schema: AdminRequiredErrorSchema } },
    },
    404: {
      description: 'Plugin not loaded',
      content: { 'application/json': { schema: PluginNotFoundErrorSchema } },
    },
    422: {
      description: 'Plugin config failed plugin-defined validation',
      content: { 'application/json': { schema: PluginConfigValidationErrorSchema } },
    },
    500: {
      description: 'Internal server error',
      content: { 'application/json': { schema: InternalServerErrorSchema } },
    },
  },
});

const ClearRenderCacheBodySchema = z.object({}).optional();

export const clearRenderCacheAllRoute = createRoute({
  method: 'post',
  path: '/admin/plugins/render-cache/clear-all',
  tags: ['admin.plugins'],
  security: [{ bearerAuth: [] }],
  summary: 'Clear every renderer plugin cache entry',
  request: {
    body: {
      content: { 'application/json': { schema: ClearRenderCacheBodySchema } },
    },
  },
  responses: {
    200: {
      description: 'Cleared (count reported)',
      content: { 'application/json': { schema: ClearRenderCacheResponseSchema } },
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

/**
 * feature-plugin-config-readiness / feature-core-config-readiness-and-mail
 * — active plugins missing config that their own `readiness` declaration
 * says is required for the currently selected driver, PLUS core config
 * declarations (`core-readiness.ts`, e.g. `mail:from`) that are unset.
 * Never returns config values, secrets, or URLs — see
 * `ConfigReadinessResponseSchema`.
 */
export const getPluginReadinessRoute = createRoute({
  method: 'get',
  path: '/admin/plugins/readiness',
  tags: ['admin.plugins'],
  security: [{ bearerAuth: [] }],
  summary: 'List active plugins and core config missing required readiness fields',
  responses: {
    200: {
      description: 'Readiness issues for active plugins and core config (empty when everything is configured)',
      content: { 'application/json': { schema: ConfigReadinessResponseSchema } },
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

export const clearRenderCachePluginRoute = createRoute({
  method: 'post',
  path: '/admin/plugins/render-cache/clear-plugin',
  tags: ['admin.plugins'],
  security: [{ bearerAuth: [] }],
  summary: 'Clear renderer plugin cache entries scoped to a single plugin',
  request: {
    query: PluginNameQuerySchema,
    body: {
      content: { 'application/json': { schema: ClearRenderCacheBodySchema } },
    },
  },
  responses: {
    200: {
      description: 'Cleared (count reported)',
      content: { 'application/json': { schema: ClearRenderCacheResponseSchema } },
    },
    401: {
      description: 'Authentication required',
      content: { 'application/json': { schema: AuthenticationRequiredErrorSchema } },
    },
    403: {
      description: 'Admin permission required',
      content: { 'application/json': { schema: AdminRequiredErrorSchema } },
    },
    404: {
      description: 'Plugin not loaded',
      content: { 'application/json': { schema: PluginNotFoundErrorSchema } },
    },
    500: {
      description: 'Internal server error',
      content: { 'application/json': { schema: InternalServerErrorSchema } },
    },
  },
});

export const adminPluginsRoutes = {
  listPluginsRoute,
  getPluginConfigRoute,
  updatePluginConfigRoute,
  getPluginReadinessRoute,
  clearRenderCacheAllRoute,
  clearRenderCachePluginRoute,
};

export type {
  ClearRenderCacheResponse,
  ConfigReadinessIssue,
  ConfigReadinessResponse,
  ListPluginsResponse,
  PluginAdminPlacement,
  PluginConfigResponse,
  PluginConfigValidationError,
  PluginField,
  PluginInfo,
  PluginNotFoundError,
  PluginReadinessField,
  UpdatePluginConfigRequest,
  UpdatePluginConfigResponse,
} from '../../schemas/admin/plugins';
