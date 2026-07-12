import Debug from 'debug';
import type { CrowiPlugin, PageMetadataAccessor, PluginContext, PluginLogger, StateCell } from '@crowi/plugin-api';
import type Crowi from 'src/crowi';
import { credentialVaultModelNamesList, isCredentialVaultModel } from './credential-vault-models';
import { formatPluginConfigKey, pluginConfigKeyPrefix } from './plugin-namespace';

/**
 * Closure over the registry of loaded plugins, used by
 * `PluginContext.dependencyConfig` to resolve another plugin's
 * configSchema. Decoupled from the PluginManager so we don't create a
 * circular import.
 */
export interface PluginLookup {
  getLoadedPlugin(name: string): CrowiPlugin | undefined;

  /**
   * Backs `PluginContext.state()`. Returns the single `StateCell` owned
   * by `pluginName`, creating it with `initial` on the first call —
   * every subsequent call (from any `PluginContext` instance built for
   * this plugin) returns the same cell and ignores `initial`. Keyed by
   * plugin name (not by `ctx` instance) so the activation-time `ctx`
   * and every later `reconfigure(ctx)` share one cell.
   */
  getOrCreateStateCell<T>(pluginName: string, initial: T): StateCell<T>;
}

/**
 * Build a `PluginContext` instance for a single plugin. The runtime
 * passes this object to every `register*` callback and to the
 * `onInstall` / `onUninstall` lifecycle hooks; from the plugin's POV
 * it's the only handle on core state.
 *
 * Each plugin gets its own context with `name` already closed over so
 * config / pageMetadata reads are scoped without the plugin needing
 * to thread the name everywhere.
 */
export function createPluginContext(plugin: CrowiPlugin, crowi: Crowi, lookup: PluginLookup): PluginContext {
  const log: PluginLogger = (() => {
    const debug = Debug(`crowi:plugin:${plugin.name}`);
    return {
      debug: (msg, ...args) => debug(msg, ...args),
      info: (msg, ...args) => debug(`[info] ${msg}`, ...args),
      warn: (msg, ...args) => console.warn(`[crowi:plugin:${plugin.name}] ${msg}`, ...args),
      error: (msg, ...args) => console.error(`[crowi:plugin:${plugin.name}] ${msg}`, ...args),
    };
  })();

  return {
    config<T>(): T {
      const schema = plugin.configSchema;
      if (!schema) {
        throw new Error(`Plugin '${plugin.name}' called config() but did not declare a configSchema.`);
      }
      const ns = readPluginConfigNamespace(crowi, plugin.name);
      const result = schema.safeParse(ns);
      if (!result.success) {
        throw new Error(`Plugin '${plugin.name}' config validation failed: ${result.error.message}`);
      }
      return result.data as T;
    },

    dependencyConfig<T>(dependencyName: string): T {
      if (!plugin.requires?.includes(dependencyName)) {
        throw new Error(`Plugin '${plugin.name}' tried to read dependency config of '${dependencyName}', but did not list it in 'requires'.`);
      }
      const dep = lookup.getLoadedPlugin(dependencyName);
      if (!dep) {
        // The PluginManager already validates `requires` at load
        // time, so this branch only fires on a programming bug.
        throw new Error(`Dependency plugin '${dependencyName}' is not loaded — PluginManager invariant broken.`);
      }
      // Declaring `requires` is only the caller's side of the contract —
      // the dependency itself must explicitly opt in to being read by
      // dependents (feature-plugin-capability-hardening). Without this,
      // any plugin could self-declare `requires: ['@crowi/plugin-aws']`
      // and read AWS credentials it was never meant to see.
      if (dep.exposesConfigToDependents !== true) {
        throw new Error(
          `Plugin '${plugin.name}' tried to read dependency config of '${dependencyName}', but the dependency did not declare 'exposesConfigToDependents'.`,
        );
      }
      const schema = dep.configSchema;
      if (!schema) {
        throw new Error(`Dependency plugin '${dependencyName}' did not declare a configSchema.`);
      }
      const ns = readPluginConfigNamespace(crowi, dependencyName);
      const result = schema.safeParse(ns);
      if (!result.success) {
        throw new Error(`Dependency plugin '${dependencyName}' config validation failed: ${result.error.message}`);
      }
      return result.data as T;
    },

    appInfo() {
      // Read `app:title` from the in-memory config cache (the same `crowi`
      // namespace readPluginConfigNamespace walks). Trim, and default an
      // empty/missing title to the seed 'Crowi' so the AppInfo contract
      // always hands plugins a non-empty name (no per-plugin fallback).
      const all = crowi.getConfig();
      const crowiNs = (all && typeof all === 'object' ? (all as { crowi?: Record<string, unknown> }).crowi : undefined) ?? {};
      const raw = crowiNs['app:title'];
      // `getBaseUrl()` is `CLIENT_URL || null`; collapse a missing/blank
      // origin to '' so the AppInfo contract stays non-null (no sensible
      // default exists for a URL — consumers check for empty).
      const base = crowi.getBaseUrl();
      return {
        title: typeof raw === 'string' && raw.trim() ? raw.trim() : 'Crowi',
        baseUrl: typeof base === 'string' && base.trim() ? base.trim() : '',
      };
    },

    async setConfig(key: string, value: unknown): Promise<void> {
      await crowi.getConfigService().saveConfigValue('crowi', formatPluginConfigKey(plugin.name, key), value);
    },

    pageMetadata: makePageMetadataAccessor(plugin.name, crowi),

    model(name: string): unknown {
      // Re-checked here (not just at boot in `assertValidModelAccess()`)
      // as defense-in-depth: a credential-vault model name must never be
      // returned even if a plugin somehow bypassed boot validation with
      // one declared in `modelAccess` (feature-plugin-capability-hardening).
      if (isCredentialVaultModel(name)) {
        throw new Error(
          `Plugin '${plugin.name}' called model('${name}'), but credential-bearing core models cannot be granted to plugins. Denied models: ${credentialVaultModelNamesList()}.`,
        );
      }
      if (!plugin.modelAccess?.includes(name)) {
        throw new Error(`Plugin '${plugin.name}' called model('${name}') but did not declare it in 'modelAccess'.`);
      }
      // crowi.model has a strongly-typed signature elsewhere; the
      // plugin contract intentionally types this loosely so plugins
      // can narrow at the call site.
      // biome-ignore lint/suspicious/noExplicitAny: Crowi.model<K> requires a literal
      return (crowi.model as any)(name);
    },

    log,

    state: <T>(initial: T) => lookup.getOrCreateStateCell(plugin.name, initial),
  };
}

/**
 * Pull the `plugin:<name>:*` rows out of the in-memory Config cache
 * and return them as a flat object keyed by the part after the second
 * colon (matching the plugin's `configSchema` shape).
 */
function readPluginConfigNamespace(crowi: Crowi, pluginName: string): Record<string, unknown> {
  const all = crowi.getConfig();
  const crowiNs = (all && typeof all === 'object' ? (all as { crowi?: Record<string, unknown> }).crowi : undefined) ?? {};
  const prefix = pluginConfigKeyPrefix(pluginName);
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(crowiNs)) {
    if (key.startsWith(prefix)) {
      out[key.slice(prefix.length)] = value;
    }
  }
  return out;
}

/**
 * Build a `PageMetadataAccessor` that scopes reads / writes to the
 * plugin's namespace on `Page.metadata`. The namespace is the plugin
 * name itself; collisions across plugins are impossible because npm
 * names are unique.
 */
function makePageMetadataAccessor(pluginName: string, crowi: Crowi): PageMetadataAccessor {
  return {
    async get<T>(pageId: string): Promise<T | null> {
      // biome-ignore lint/suspicious/noExplicitAny: Crowi.model<K> requires a literal
      const Page = (crowi.model as any)('Page');
      const doc = await Page.findOne({ _id: pageId }).select('metadata').lean();
      if (!doc?.metadata || typeof doc.metadata !== 'object') return null;
      const slot = (doc.metadata as Record<string, unknown>)[pluginName];
      return (slot as T | undefined) ?? null;
    },

    async set<T>(pageId: string, value: T): Promise<void> {
      // biome-ignore lint/suspicious/noExplicitAny: Crowi.model<K> requires a literal
      const Page = (crowi.model as any)('Page');
      await Page.updateOne({ _id: pageId }, { $set: { [`metadata.${pluginName}`]: value } });
    },

    async remove(pageId: string): Promise<void> {
      // biome-ignore lint/suspicious/noExplicitAny: Crowi.model<K> requires a literal
      const Page = (crowi.model as any)('Page');
      await Page.updateOne({ _id: pageId }, { $unset: { [`metadata.${pluginName}`]: '' } });
    },
  };
}
