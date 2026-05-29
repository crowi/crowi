---
'@crowi/plugin-search-opensearch': minor
'@crowi/plugin-search-elasticsearch': minor
---

Added a new plugin `@crowi/plugin-search-opensearch` for using OpenSearch as the search backend. Adding the plugin name to `plugins[]` in `crowi.config.json` and setting `search.driver: 'opensearch'` lets you use an OpenSearch cluster as the search backend via `@opensearch-project/opensearch`. Behaviour matches `@crowi/plugin-search-elasticsearch`: hot-reload via state-ref + snapshot, atomic rebuild using a `<indexName>-current` alias, and the three `default` / `kuromoji` / `sudachi` analyzers. AWS SigV4 auth is not supported (Basic Auth-based url only). Because analysis-kuromoji is shipped as a separate distribution on OpenSearch, operators must install it separately with `bin/opensearch-plugin install analysis-kuromoji` (see the README).

Also removed `@crowi/plugin-search-elasticsearch`'s `onInstall` (auto-migration from the `ELASTICSEARCH_URI` / `BONSAI_URL` env vars to the plugin config namespace `url`), unifying both plugins' configuration path onto the single admin UI. Since Crowi 2.0 is in alpha development and not yet in production, there is no backward-compat fallback; operators set the url in the admin UI, then build the initial index with `crowi-admin search rebuild`. Accordingly, the `ELASTICSEARCH_URI` references were removed from `.env.example` / `docker-compose.yml` / related docs.
