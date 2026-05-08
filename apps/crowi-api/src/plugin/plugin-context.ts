import Debug from 'debug';
import type { CrowiPlugin, PageMetadataAccessor, PluginContext, PluginCrypto, PluginLogger } from '@crowi/plugin-api';
import type Crowi from 'src/crowi';
import { decrypt, encrypt } from 'src/util/crypto';

/**
 * Closure over the registry of loaded plugins, used by
 * `PluginContext.dependencyConfig` to resolve another plugin's
 * configSchema. Decoupled from the PluginManager so we don't create a
 * circular import.
 */
export interface PluginLookup {
  getLoadedPlugin(name: string): CrowiPlugin | undefined;
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

  const crypto: PluginCrypto = { encrypt, decrypt };

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

    async setConfig(key: string, value: unknown): Promise<void> {
      const fullKey = `plugin:${plugin.name}:${key}`;
      await crowi.getConfigService().saveConfigValue('crowi', fullKey, value);
    },

    pageMetadata: makePageMetadataAccessor(plugin.name, crowi),

    model(name: string): unknown {
      // crowi.model has a strongly-typed signature elsewhere; the
      // plugin contract intentionally types this loosely so plugins
      // can narrow at the call site.
      // biome-ignore lint/suspicious/noExplicitAny: Crowi.model<K> requires a literal
      return (crowi.model as any)(name);
    },

    crypto,
    log,
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
  const prefix = `plugin:${pluginName}:`;
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
