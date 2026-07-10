---
"@crowi/api": patch
"@crowi/api-contract": minor
"@crowi/web": patch
---

Isolate a single plugin's boot-time failure so it no longer takes the whole server down with it.

`PluginManager.bootstrap()`'s activation loop and `mountPluginRoutes`'s `registerRoutes` loop previously had no per-plugin try/catch, unlike the existing `runReconfigure`/`deactivate` lifecycle paths — a plugin that threw during `activate()` (a bad `registerStorage`, a failing `onInstall` migration, ...) or during `registerRoutes` (an exception while building its HTTP routes) took the entire boot down, leaving even the admin UI unreachable for disabling it. Both loops are now isolated per plugin: an `activate()` failure logs `[crowi:plugin:<name>] activation failed; plugin disabled: <message>`, excludes that plugin from `PluginManager.getLoadedPlugins()`/`getLoadedPlugin(name)`, and is recorded in the new `PluginManager.getFailedPlugins()`; a `registerRoutes` failure logs `[crowi:plugin:<name>] registerRoutes failed; this plugin's HTTP routes are not mounted: <message>` but leaves the plugin's driver registrations (and its `getLoadedPlugins()` membership) intact, since activation itself already succeeded. `GET /admin/plugins` now includes failed plugins with `status: 'failed'` and their error message (successful plugins get `status: 'active'`), and the admin plugin list shows an "Activation failed" badge for them. Deliberately out of scope for this change: rolling back a partially-completed `activate()` call's earlier `register*` calls, and a hard-fail path for plugins that provide an implicit-default driver (`storage.driver: 'local'` / `search.driver: 'mongo'`) — every plugin is isolated the same best-effort way for now.
