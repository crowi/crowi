/**
 * Domain events emitted by core. The full event payload shapes live in
 * `@crowi/server`; this contract publishes only the event names so the
 * type signature of `EventBus.on` stays type-safe at the plugin layer.
 *
 * `pluginHooks` are the v2.0 internal-use-only events. Community
 * plugins should NOT subscribe — the surface is reserved while we
 * stabilise it.
 */
export interface PluginEvents {
  'page:created': { pageId: string; path: string };
  'page:updated': { pageId: string; path: string };
  'page:deleted': { pageId: string; path: string };
  'page:renamed': { pageId: string; oldPath: string; newPath: string };
  'comment:added': { pageId: string; commentId: string };
  'comment:removed': { pageId: string; commentId: string };
  'user:registered': { userId: string };
  'user:activated': { userId: string };
}

export interface EventBus {
  on<K extends keyof PluginEvents>(event: K, listener: (payload: PluginEvents[K]) => void | Promise<void>): void;
}
