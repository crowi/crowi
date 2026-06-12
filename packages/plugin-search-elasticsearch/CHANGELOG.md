# @crowi/plugin-search-elasticsearch

## 0.1.0-alpha.0

### Minor Changes

- a52d03f: Initial publish preparation: monorepo restructure complete (RFC-0002 →
  feature-monorepo-packages-restructure). All packages now use
  workspace: protocol internally, peerDependencies for plugin boundaries,
  shared @crowi/tsconfig presets, and a publish-ready layout under
  packages/\*.
- 72dd9c3: Added a new plugin `@crowi/plugin-search-opensearch` for using OpenSearch as the search backend. Adding the plugin name to `plugins[]` in `crowi.config.json` and setting `search.driver: 'opensearch'` lets you use an OpenSearch cluster as the search backend via `@opensearch-project/opensearch`. Behaviour matches `@crowi/plugin-search-elasticsearch`: hot-reload via state-ref + snapshot, atomic rebuild using a `<indexName>-current` alias, and the three `default` / `kuromoji` / `sudachi` analyzers. AWS SigV4 auth is not supported (Basic Auth-based url only). Because analysis-kuromoji is shipped as a separate distribution on OpenSearch, operators must install it separately with `bin/opensearch-plugin install analysis-kuromoji` (see the README).

  Also removed `@crowi/plugin-search-elasticsearch`'s `onInstall` (auto-migration from the `ELASTICSEARCH_URI` / `BONSAI_URL` env vars to the plugin config namespace `url`), unifying both plugins' configuration path onto the single admin UI. Since Crowi 2.0 is in alpha development and not yet in production, there is no backward-compat fallback; operators set the url in the admin UI, then build the initial index with `crowi-admin search rebuild`. Accordingly, the `ELASTICSEARCH_URI` references were removed from `.env.example` / `docker-compose.yml` / related docs.

- 4df1301: The Elasticsearch search plugin now supports config hot-reload. Changing the ES connection URL / indexName / analyzer / requestTimeout in the admin UI and saving takes effect from the next search query without restarting the server.

  Implemented `reconfigure(ctx)` on the plugin and rewrote the driver into a state-ref + snapshot structure. On a config change it rebuilds all fields and swaps the state, and `close()`s the old ES Client fire-and-forget to drain its keep-alive pool. Search requests in flight during a config change keep seeing the snapshot they started with, so consistency is preserved. `PluginInfo.supportsHotReload` becomes `true`, and the admin UI shows an "applied immediately" toast.

  Note: when you change the analyzer, the existing index keeps the old analyzer, so a manual rebuild is needed to activate the new one (see the plugin README for details).

### Patch Changes

- Updated dependencies [a52d03f]
- Updated dependencies [966d133]
- Updated dependencies [7f77407]
  - @crowi/plugin-api@0.1.0-alpha.0
