import type Crowi from 'src/crowi';

/**
 * Dedicated Config namespace for onInstall install-once tracking.
 * Deliberately NOT nested under `plugin:<name>:*` (the plugin's own
 * config namespace, see plugin-namespace.ts) — several first-party
 * plugins declare `configSchema` with `.strict()` (e.g. SlackConfigSchema),
 * and `ctx.config()` safe-parses the raw `plugin:<name>:*` key set
 * against that schema. An extra untyped key in that namespace would
 * fail strict-schema validation and break plugin boot.
 */
const INSTALL_TRACKING_NS = 'plugin-installed';

/**
 * Whether `pluginName`'s `onInstall` has already completed
 * successfully in a previous boot, per the in-memory Config cache
 * (`Crowi.getConfig()`, refreshed from Mongo on every `saveConfigValue`
 * call — see `ConfigService`). Used by `PluginManager.activate()` to
 * decide whether to call `onInstall` again.
 */
export function isPluginInstalled(crowi: Crowi, pluginName: string): boolean {
  const all = crowi.getConfig();
  const ns = (all && typeof all === 'object' ? (all as Record<string, unknown>)[INSTALL_TRACKING_NS] : undefined) as Record<string, unknown> | undefined;
  return !!ns?.[pluginName];
}

/**
 * Record that `pluginName`'s `onInstall` completed successfully, so
 * subsequent boots skip it (see `isPluginInstalled`). Value is a
 * timestamp string purely for operator/log-reading convenience — only
 * truthiness is ever checked.
 */
export async function markPluginInstalled(crowi: Crowi, pluginName: string): Promise<void> {
  await crowi.getConfigService().saveConfigValue(INSTALL_TRACKING_NS, pluginName, new Date().toISOString());
}
