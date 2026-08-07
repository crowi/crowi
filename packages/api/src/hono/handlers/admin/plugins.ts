/**
 * RFC-0006 Phase 4 Batch 9 — `admin.plugins` resource Hono port.
 *
 * Replaces `packages/api/src/routes/ts-rest/admin/plugins.ts`. 6
 * admin-only endpoints (list / get config / put config / readiness
 * [feature-plugin-config-readiness] / clear all cache / clear plugin
 * cache).
 *
 * Auth:
 *   - Admin-only via broad `createJwtAdminRequired(crowi)` apply on
 *     `/admin/plugins/*` + the bare `/admin/plugins` path.
 *
 * Plugin npm names contain a `/` (e.g. `@crowi/plugin-storage-local`)
 * which collides with the Hono router's path-segment matching, so the
 * name is passed as a query string rather than a path parameter.
 */
import { type ConfigReadinessIssue, type PluginInfo, adminPluginsRoutes } from '@crowi/api-contract';
import type { OpenAPIHono } from '@hono/zod-openapi';
import type { CrowiPlugin } from '@crowi/plugin-api';
import Debug from 'debug';

import type Crowi from 'src/crowi';
import { readCrowiConfigNamespace } from 'src/plugin/plugin-namespace';
import { type SerializedPluginField, serializeConfigSchema } from 'src/plugin/schema-serializer';

import type { CrowiHonoBindings } from '../../app';
import { createJwtAdminRequired } from '../../middleware/admin';
import { INTERNAL_ERROR_BODY } from '../_helpers/errors';

const debug = Debug('crowi:hono:handlers:admin:plugins');

const pluginNotFoundBody = (name: string) => ({
  error: {
    code: 'PLUGIN_NOT_FOUND' as const,
    message: `Plugin '${name}' is not loaded`,
  },
});

/**
 * Overlay a plugin's `configI18n[locale]` label/description translations onto
 * the schema-derived fields (案A — translations ship with the plugin). The
 * Zod `.describe()` text remains the default when a locale or a field entry
 * is absent.
 */
const localizeFields = (
  fields: SerializedPluginField[],
  i18n: CrowiPlugin['configI18n'],
  locale: string | undefined,
): (SerializedPluginField & { label?: string })[] => {
  const table = locale ? i18n?.[locale] : undefined;
  if (!table) return fields;
  return fields.map((field) => {
    const t = table[field.name];
    if (!t) return field;
    return {
      ...field,
      ...(t.label ? { label: t.label } : {}),
      ...(t.description ? { description: t.description } : {}),
    };
  });
};

const collectRegistrySlots = (plugin: CrowiPlugin): string[] => {
  const slots: string[] = [];
  if (plugin.registerStorage) slots.push('storage');
  if (plugin.registerSearch) slots.push('search');
  if (plugin.registerAuth) slots.push('auth');
  if (plugin.registerNotifier) slots.push('notifier');
  if (plugin.registerMailSender) slots.push('mail');
  return slots;
};

const deriveSectionFromHooks = (plugin: CrowiPlugin): PluginInfo['adminPlacement']['section'] | undefined => {
  if (plugin.registerStorage) return 'storage';
  if (plugin.registerAuth) return 'auth';
  if (plugin.registerNotifier) return 'notification';
  if (plugin.registerMailSender) return 'mail';
  if (plugin.registerSearch) return 'search';
  if (plugin.registerRenderer) return 'renderer';
  return undefined;
};

const resolvePlacement = (plugin: CrowiPlugin): PluginInfo['adminPlacement'] => {
  const declared = plugin.adminPlacement;
  const derivedSection = deriveSectionFromHooks(plugin);
  return {
    section: declared?.section ?? derivedSection ?? 'settings',
    label: declared?.label ?? plugin.name,
    icon: declared?.icon,
  };
};

const hasReconfigureOrDependent = (plugin: CrowiPlugin, all: readonly CrowiPlugin[]): boolean => {
  if (plugin.reconfigure) return true;
  for (const other of all) {
    if (other.requires?.includes(plugin.name) && other.reconfigure) return true;
  }
  return false;
};

// `failure` is only ever passed for a plugin from `getFailedPlugins()`, so
// its presence alone determines `status: 'failed'` — no need to carry a
// redundant `status` literal alongside the error message.
const toPluginInfo = (plugin: CrowiPlugin, all: readonly CrowiPlugin[], failure?: { error: string }): PluginInfo => ({
  name: plugin.name,
  version: plugin.version,
  requires: plugin.requires,
  modelAccess: plugin.modelAccess,
  hasConfig: !!plugin.configSchema,
  registers: collectRegistrySlots(plugin),
  adminPlacement: resolvePlacement(plugin),
  supportsHotReload: hasReconfigureOrDependent(plugin, all),
  status: failure ? 'failed' : 'active',
  error: failure?.error,
});

const readPluginNamespace = (crowi: Crowi, pluginName: string): Record<string, unknown> => {
  const crowiNs = readCrowiConfigNamespace(crowi.getConfig());
  const prefix = `plugin:${pluginName}:`;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(crowiNs)) {
    if (key.startsWith(prefix)) {
      out[key.slice(prefix.length)] = value;
    }
  }
  return out;
};

export const registerAdminPluginsRoutes = <E extends OpenAPIHono<CrowiHonoBindings>>(app: E, crowi: Crowi) => {
  app.use('/admin/plugins/*', createJwtAdminRequired(crowi));
  app.use('/admin/plugins', createJwtAdminRequired(crowi));

  return app
    .openapi(adminPluginsRoutes.listPluginsRoute, async (c) => {
      const manager = crowi.pluginManager;
      if (!manager) return c.json({ plugins: [] }, 200);
      // `all` (used for `hasReconfigureOrDependent`'s "any dependent
      // implements reconfigure" walk) is intentionally the successfully
      // activated set only — a plugin that failed activation never
      // registered a driver, so it cannot be a reconfigure-relevant
      // dependency target either.
      const all = manager.getLoadedPlugins();
      const activePlugins = all.map((p) => toPluginInfo(p, all));
      const failedPlugins = manager.getFailedPlugins().map((f) => toPluginInfo(f.plugin, all, { error: f.error }));
      return c.json({ plugins: [...activePlugins, ...failedPlugins] }, 200);
    })
    .openapi(adminPluginsRoutes.getPluginConfigRoute, async (c) => {
      const { name, locale } = c.req.valid('query');
      const manager = crowi.pluginManager;
      const plugin = manager?.getLoadedPlugin(name);
      if (!plugin) return c.json(pluginNotFoundBody(name), 404);

      if (!plugin.configSchema) {
        return c.json({ name: plugin.name, fields: [], values: {} }, 200);
      }

      const fields = localizeFields(serializeConfigSchema(plugin.configSchema), plugin.configI18n, locale);
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
      return c.json({ name: plugin.name, fields, values }, 200);
    })
    .openapi(adminPluginsRoutes.getPluginReadinessRoute, async (c) => {
      const manager = crowi.pluginManager;
      if (!manager) return c.json({ issues: [] }, 200);
      // `getReadinessIssues()` already did the candidate filtering +
      // config evaluation and returns only field names (never a value) —
      // this projects each internal issue onto the wire `ConfigReadinessIssue`:
      // a plugin issue resolves its `adminPlacement` (same helper
      // `listPlugins` uses) into `label` + the plugin-edit href, a core
      // issue copies the declaration's own `label`/`href` straight
      // through (feature-core-config-readiness-and-mail).
      const issues = manager
        .getReadinessIssues()
        .map((issue): ConfigReadinessIssue | null => {
          if (issue.source === 'core') {
            return { id: issue.id, source: 'core', label: issue.label, href: issue.href, fields: issue.fields };
          }
          const plugin = manager.getLoadedPlugin(issue.pluginName);
          if (!plugin) return null;
          return {
            id: issue.id,
            source: 'plugin',
            label: resolvePlacement(plugin).label,
            href: `/admin/plugins/edit?name=${encodeURIComponent(issue.pluginName)}`,
            fields: issue.fields,
          };
        })
        .filter((issue): issue is ConfigReadinessIssue => issue !== null);
      return c.json({ issues }, 200);
    })
    .openapi(adminPluginsRoutes.updatePluginConfigRoute, async (c) => {
      const { name } = c.req.valid('query');
      const body = c.req.valid('json');
      const manager = crowi.pluginManager;
      const plugin = manager?.getLoadedPlugin(name);
      if (!plugin) return c.json(pluginNotFoundBody(name), 404);

      if (!plugin.configSchema) {
        return c.json(
          {
            error: {
              code: 'PLUGIN_CONFIG_VALIDATION_FAILED' as const,
              message: 'Plugin does not declare any configurable values',
              issues: [],
            },
          },
          422,
        );
      }

      const fields = serializeConfigSchema(plugin.configSchema);
      const fieldsByName = new Map(fields.map((f) => [f.name, f]));

      const existing = readPluginNamespace(crowi, plugin.name);
      const merged: Record<string, unknown> = { ...existing };
      const toWrite: Record<string, unknown> = {};

      for (const [key, value] of Object.entries(body.values)) {
        const field = fieldsByName.get(key);
        if (!field) continue;
        if (field.kind === 'secret' && value === undefined) continue;
        merged[key] = value;
        toWrite[key] = value;
      }

      const parsed = plugin.configSchema.safeParse(merged);
      if (!parsed.success) {
        return c.json(
          {
            error: {
              code: 'PLUGIN_CONFIG_VALIDATION_FAILED' as const,
              message: 'Plugin config failed validation',
              issues: parsed.error.issues.map((i) => ({
                path: i.path.map((p): string | number => (typeof p === 'symbol' ? String(p) : p)),
                message: i.message,
              })),
            },
          },
          422,
        );
      }

      const configService = crowi.getConfigService();

      // RFC-0014 phase 4 — fields belonging to a `configAtomicGroups` group
      // leave the ordinary per-key write path entirely. A group is touched
      // as a whole whenever ANY of its members is in the request, and the
      // values written are taken from the VALIDATED merge (`parsed.data`),
      // not from the request: that is what supplies an omitted secret from
      // the currently-stored value, so saving only the client id can never
      // blank the secret next to it.
      const atomicGroups = plugin.configAtomicGroups ?? [];
      const touchedGroups = atomicGroups.filter((group) => group.keys.some((key) => key in toWrite));
      const atomicFieldNames = new Set(atomicGroups.flatMap((group) => group.keys));

      const writes: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(toWrite)) {
        if (atomicFieldNames.has(key)) continue;
        writes[`plugin:${plugin.name}:${key}`] = value;
      }

      try {
        for (const group of touchedGroups) {
          const values: Record<string, string> = {};
          for (const key of group.keys) {
            values[key] = String((parsed.data as Record<string, unknown>)[key] ?? '');
          }
          // Throws on a failed write, and deliberately runs BEFORE the
          // ordinary writes and the reconfigure below: nothing may observe
          // a credential group that was not persisted.
          await configService.saveConfigAtomicGroup('crowi', plugin.name, group.name, values);
        }
        if (Object.keys(writes).length > 0) {
          await configService.saveConfig('crowi', writes);
        }
      } catch (err) {
        debug('Error saving plugin config:', (err as Error).message);
        return c.json(INTERNAL_ERROR_BODY, 500);
      }

      let hotReloaded = false;
      let reconfigureFailed = false;
      const pluginManager = crowi.pluginManager;
      if (pluginManager && (Object.keys(writes).length > 0 || touchedGroups.length > 0)) {
        const result = await pluginManager.reconfigureAffected([`plugin:${plugin.name}`]);
        hotReloaded = result.attempted > 0 && result.succeeded === result.attempted;
        reconfigureFailed = result.attempted > result.succeeded;
      }

      return c.json({ ok: true as const, hotReloaded, reconfigureFailed }, 200);
    })
    .openapi(adminPluginsRoutes.clearRenderCacheAllRoute, async (c) => {
      const renderer = crowi.renderer;
      if (!renderer) return c.json(INTERNAL_ERROR_BODY, 500);
      try {
        const removedCount = await renderer.cache.invalidateAll();
        return c.json({ ok: true as const, clearedAt: new Date().toISOString(), removedCount }, 200);
      } catch (err) {
        debug('clearRenderCacheAll failed:', (err as Error).message);
        return c.json(INTERNAL_ERROR_BODY, 500);
      }
    })
    .openapi(adminPluginsRoutes.clearRenderCachePluginRoute, async (c) => {
      const { name } = c.req.valid('query');
      const renderer = crowi.renderer;
      const manager = crowi.pluginManager;
      if (!renderer) return c.json(INTERNAL_ERROR_BODY, 500);
      if (manager && !manager.getLoadedPlugin(name)) return c.json(pluginNotFoundBody(name), 404);
      try {
        const removedCount = await renderer.cache.invalidatePlugin(name);
        return c.json({ ok: true as const, clearedAt: new Date().toISOString(), removedCount }, 200);
      } catch (err) {
        debug('clearRenderCachePlugin failed:', (err as Error).message);
        return c.json(INTERNAL_ERROR_BODY, 500);
      }
    });
};
