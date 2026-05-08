import { createExpressEndpoints, initServer } from '@ts-rest/express';
import { Express, Router } from 'express';
import { apiContract, type PluginInfo } from '@crowi/api-contract';
import type { CrowiPlugin } from '@crowi/plugin-api';
import Crowi from 'src/crowi';
import { serializeConfigSchema } from 'src/plugin/schema-serializer';
import { internalServerErrorResponse } from 'src/util/ts-rest-helpers';
import Debug from 'debug';

const debug = Debug('crowi:routes:ts-rest:admin:plugins');

export default (crowi: Crowi, _app: Express) => {
  const s = initServer();
  const router = Router();

  const pluginsRouter = s.router(apiContract.admin.plugins, {
    /**
     * GET /api/v2/admin/plugins
     *
     * Lists every plugin currently loaded by the PluginManager along
     * with its declared registry slots. The admin "Plugins" page
     * renders this as a table.
     */
    listPlugins: async () => {
      const manager = crowi.pluginManager;
      if (!manager) {
        return { status: 200 as const, body: { plugins: [] } };
      }
      const plugins = manager.getLoadedPlugins().map(toPluginInfo);
      return { status: 200 as const, body: { plugins } };
    },

    /**
     * GET /api/v2/admin/plugins/:name/config
     *
     * Get the form schema + current values for a single plugin.
     * Sensitive fields are masked to `{ hasValue: boolean }` before
     * returning so plaintext secrets never reach the browser.
     */
    getPluginConfig: async ({ query }) => {
      const manager = crowi.pluginManager;
      const plugin = manager?.getLoadedPlugin(query.name);
      if (!plugin) {
        return pluginNotFound(query.name);
      }
      if (!plugin.configSchema) {
        // Plugin has no configurable values; return an empty form.
        return {
          status: 200 as const,
          body: { name: plugin.name, fields: [], values: {} },
        };
      }

      const fields = serializeConfigSchema(plugin.configSchema);
      const ns = readPluginNamespace(crowi, plugin.name);
      const values: Record<string, unknown> = {};
      for (const field of fields) {
        if (field.kind === 'secret') {
          const raw = ns[field.name];
          values[field.name] = { hasValue: typeof raw === 'string' && raw.length > 0 };
        } else {
          values[field.name] = ns[field.name] ?? field.defaultValue ?? null;
        }
      }
      return {
        status: 200 as const,
        body: { name: plugin.name, fields, values },
      };
    },

    /**
     * PUT /api/v2/admin/plugins/:name/config
     *
     * Validate the request body through the plugin's Zod schema and
     * persist each field into `plugin:<name>:*` config rows. Sensitive
     * fields follow the three-state convention used by /admin/app and
     * /admin/mail:
     *   - undefined / missing → leave value untouched
     *   - empty string         → clear the saved value
     *   - non-empty string     → replace and re-encrypt
     */
    updatePluginConfig: async ({ query, body }) => {
      const manager = crowi.pluginManager;
      const plugin = manager?.getLoadedPlugin(query.name);
      if (!plugin) {
        return pluginNotFound(query.name);
      }
      if (!plugin.configSchema) {
        return {
          status: 422 as const,
          body: {
            error: {
              code: 'PLUGIN_CONFIG_VALIDATION_FAILED' as const,
              message: 'Plugin does not declare any configurable values',
              issues: [],
            },
          },
        };
      }

      const fields = serializeConfigSchema(plugin.configSchema);
      const fieldsByName = new Map(fields.map((f) => [f.name, f]));

      // Build a candidate object using new values + existing values
      // for fields the operator did not touch (so secret-untouched
      // doesn't overwrite the saved secret).
      const existing = readPluginNamespace(crowi, plugin.name);
      const merged: Record<string, unknown> = { ...existing };
      const toWrite: Record<string, unknown> = {};

      for (const [key, value] of Object.entries(body.values)) {
        const field = fieldsByName.get(key);
        if (!field) {
          // Ignore unknown keys. The Zod parse below would also catch
          // them via `.strict()`, but we strip first so users get
          // friendlier per-field errors instead of a global one.
          continue;
        }
        if (field.kind === 'secret' && value === undefined) {
          // explicitly leave untouched
          continue;
        }
        merged[key] = value;
        toWrite[key] = value;
      }

      const parsed = plugin.configSchema.safeParse(merged);
      if (!parsed.success) {
        return {
          status: 422 as const,
          body: {
            error: {
              code: 'PLUGIN_CONFIG_VALIDATION_FAILED' as const,
              message: 'Plugin config failed validation',
              issues: parsed.error.issues.map((i) => ({
                path: i.path.map((p): string | number => (typeof p === 'symbol' ? String(p) : p)),
                message: i.message,
              })),
            },
          },
        };
      }

      const configService = crowi.getConfigService();
      try {
        const writes: Record<string, unknown> = {};
        for (const [key, value] of Object.entries(toWrite)) {
          writes[`plugin:${plugin.name}:${key}`] = value;
        }
        if (Object.keys(writes).length > 0) {
          await configService.saveConfig('crowi', writes);
        }
      } catch (err) {
        const error = err as Error;
        debug('Error saving plugin config:', error.message);
        return internalServerErrorResponse;
      }

      return { status: 200 as const, body: { ok: true as const } };
    },
  });

  createExpressEndpoints(apiContract.admin.plugins, pluginsRouter, router);
  return router;
};

const toPluginInfo = (plugin: CrowiPlugin): PluginInfo => ({
  name: plugin.name,
  version: plugin.version,
  requires: plugin.requires,
  hasConfig: !!plugin.configSchema,
  registers: collectRegistrySlots(plugin),
});

function collectRegistrySlots(plugin: CrowiPlugin): string[] {
  const slots: string[] = [];
  if (plugin.registerStorage) slots.push('storage');
  if (plugin.registerSearch) slots.push('search');
  if (plugin.registerAuth) slots.push('auth');
  if (plugin.registerNotifier) slots.push('notifier');
  return slots;
}

function readPluginNamespace(crowi: Crowi, pluginName: string): Record<string, unknown> {
  const all = crowi.getConfig();
  const crowiNs = (all && typeof all === 'object' ? (all as { crowi?: Record<string, unknown> }).crowi : undefined) ?? {};
  const prefix = `plugin:${pluginName}:`;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(crowiNs)) {
    if (key.startsWith(prefix)) {
      out[key.slice(prefix.length)] = value;
    }
  }
  return out;
}

const pluginNotFound = (name: string) =>
  ({
    status: 404 as const,
    body: {
      error: {
        code: 'PLUGIN_NOT_FOUND' as const,
        message: `Plugin '${name}' is not loaded`,
      },
    },
  }) as const;
