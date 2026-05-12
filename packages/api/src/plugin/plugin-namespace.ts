/**
 * Single source of truth for the `plugin:<name>[:<field>]` key / namespace
 * shape that's an inter-module contract between `service/config.ts` and
 * `plugin/plugin-manager.ts` (and `plugin/plugin-context.ts`).
 *
 * Plugin names are npm package names (e.g. `@crowi/plugin-aws`) and may
 * contain `/` but never `:` — npm package names allow `[a-z0-9-_./]`.
 * Parse helpers therefore split on the first two `:` rather than greedy
 * regex alternatives, so a future plugin name with extra characters
 * doesn't silently break.
 */

const PLUGIN_PREFIX = 'plugin:';

export function formatPluginConfigKey(pluginName: string, field: string): string {
  return `${PLUGIN_PREFIX}${pluginName}:${field}`;
}

export function formatPluginNamespace(pluginName: string): string {
  return `${PLUGIN_PREFIX}${pluginName}`;
}

export function pluginConfigKeyPrefix(pluginName: string): string {
  return `${PLUGIN_PREFIX}${pluginName}:`;
}

/**
 * Extract the plugin name from a `plugin:<name>` namespace string.
 * Returns null when the namespace isn't plugin-shaped, so callers can
 * `continue` cleanly on `crowi:*` / `notification:*` etc.
 */
export function parsePluginNamespace(ns: string): string | null {
  if (!ns.startsWith(PLUGIN_PREFIX)) return null;
  const name = ns.slice(PLUGIN_PREFIX.length);
  return name.length > 0 ? name : null;
}

/**
 * Extract the plugin name from a full `plugin:<name>:<field>` config
 * key. Returns null when the key isn't plugin-shaped.
 */
export function parsePluginConfigKey(key: string): { pluginName: string; field: string } | null {
  if (!key.startsWith(PLUGIN_PREFIX)) return null;
  const rest = key.slice(PLUGIN_PREFIX.length);
  const sep = rest.lastIndexOf(':');
  if (sep <= 0 || sep === rest.length - 1) return null;
  return { pluginName: rest.slice(0, sep), field: rest.slice(sep + 1) };
}
