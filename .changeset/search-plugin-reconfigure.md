---
'@crowi/plugin-search-elasticsearch': minor
---

The Elasticsearch search plugin now supports config hot-reload. Changing the ES connection URL / indexName / analyzer / requestTimeout in the admin UI and saving takes effect from the next search query without restarting the server.

Implemented `reconfigure(ctx)` on the plugin and rewrote the driver into a state-ref + snapshot structure. On a config change it rebuilds all fields and swaps the state, and `close()`s the old ES Client fire-and-forget to drain its keep-alive pool. Search requests in flight during a config change keep seeing the snapshot they started with, so consistency is preserved. `PluginInfo.supportsHotReload` becomes `true`, and the admin UI shows an "applied immediately" toast.

Note: when you change the analyzer, the existing index keeps the old analyzer, so a manual rebuild is needed to activate the new one (see the plugin README for details).
