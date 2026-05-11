import { initContract } from '@ts-rest/core';
import { z } from 'zod';
import {
  ClearRenderCacheResponseSchema,
  ListPluginsResponseSchema,
  PluginConfigResponseSchema,
  PluginConfigValidationErrorSchema,
  PluginNotFoundErrorSchema,
  UpdatePluginConfigRequestSchema,
  UpdatePluginConfigResponseSchema,
} from '../../schemas/admin/plugins';
import { AdminRequiredErrorSchema, AuthenticationRequiredErrorSchema } from '../../schemas/common';

const c = initContract();

/**
 * Plugin npm names contain a `/` (e.g. `@crowi/plugin-storage-local`), which
 * collides with Express's path-segment matching when used as a path
 * param. We pass the name as a query string so ts-rest / Express
 * don't have to deal with the slash in the URL path.
 */
const PluginNameQuerySchema = z.object({ name: z.string() });

export const adminPluginsContract = c.router({
  /**
   * List all plugins currently loaded by the runtime PluginManager.
   * Surfaced in the admin "Plugins" page.
   */
  listPlugins: {
    method: 'GET',
    path: '/admin/plugins',
    responses: {
      200: ListPluginsResponseSchema,
      401: AuthenticationRequiredErrorSchema,
      403: AdminRequiredErrorSchema,
    },
  },

  /**
   * Get a single plugin's config form schema + current values. The
   * plaintext of any sensitive field is replaced with
   * `{ hasValue: boolean }` so the secret never traverses the wire
   * back to the admin form.
   */
  getPluginConfig: {
    method: 'GET',
    path: '/admin/plugins/config',
    query: PluginNameQuerySchema,
    responses: {
      200: PluginConfigResponseSchema,
      401: AuthenticationRequiredErrorSchema,
      403: AdminRequiredErrorSchema,
      404: PluginNotFoundErrorSchema,
    },
  },

  /**
   * Update a plugin's config. The request body is validated against
   * the plugin's Zod schema before persisting; per-field errors are
   * surfaced in the 422 response.
   */
  updatePluginConfig: {
    method: 'PUT',
    path: '/admin/plugins/config',
    query: PluginNameQuerySchema,
    body: UpdatePluginConfigRequestSchema,
    responses: {
      200: UpdatePluginConfigResponseSchema,
      401: AuthenticationRequiredErrorSchema,
      403: AdminRequiredErrorSchema,
      404: PluginNotFoundErrorSchema,
      422: PluginConfigValidationErrorSchema,
    },
  },

  /**
   * Clear all renderer plugin cache entries. Used by the admin
   * "Clear all render cache" button — equivalent to
   * `MongoCacheStorage.invalidateAll()`. Returns the row delete count.
   */
  clearRenderCacheAll: {
    method: 'POST',
    path: '/admin/plugins/render-cache/clear-all',
    body: z.object({}).optional(),
    responses: {
      200: ClearRenderCacheResponseSchema,
      401: AuthenticationRequiredErrorSchema,
      403: AdminRequiredErrorSchema,
    },
  },

  /**
   * Clear renderer plugin cache entries scoped to a single plugin.
   * Used by the per-plugin "Clear cache for this plugin" button.
   * Returns 404 when the named plugin is not loaded.
   */
  clearRenderCachePlugin: {
    method: 'POST',
    path: '/admin/plugins/render-cache/clear-plugin',
    query: PluginNameQuerySchema,
    body: z.object({}).optional(),
    responses: {
      200: ClearRenderCacheResponseSchema,
      401: AuthenticationRequiredErrorSchema,
      403: AdminRequiredErrorSchema,
      404: PluginNotFoundErrorSchema,
    },
  },
});
