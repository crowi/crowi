# @crowi/plugin-search-opensearch

## 0.1.0-alpha.1

### Patch Changes

- ff63cd1: Declare an explicit `zod` peer dependency range (`^4`) instead of `catalog:`. pnpm does not resolve the `catalog:` protocol inside `peerDependencies` during a workspace/source install, so building Crowi from source emitted a spurious `unmet peer zod@catalog:` warning for every plugin. Published packages were already correct (pnpm rewrites `catalog:` to a concrete range on publish), so npm consumers were unaffected — this only silences the noisy source/Docker-build install. Declaring `^4` also more honestly states that the plugins are compatible with any zod 4.x the host application provides.
- Updated dependencies [ff63cd1]
  - @crowi/plugin-api@0.1.0-alpha.1

## 0.1.0-alpha.0

### Minor Changes

- 72dd9c3: Added a new plugin `@crowi/plugin-search-opensearch` for using OpenSearch as the search backend. Adding the plugin name to `plugins[]` in `crowi.config.json` and setting `search.driver: 'opensearch'` lets you use an OpenSearch cluster as the search backend via `@opensearch-project/opensearch`. Behaviour matches `@crowi/plugin-search-elasticsearch`: hot-reload via state-ref + snapshot, atomic rebuild using a `<indexName>-current` alias, and the three `default` / `kuromoji` / `sudachi` analyzers. AWS SigV4 auth is not supported (Basic Auth-based url only). Because analysis-kuromoji is shipped as a separate distribution on OpenSearch, operators must install it separately with `bin/opensearch-plugin install analysis-kuromoji` (see the README).

  Also removed `@crowi/plugin-search-elasticsearch`'s `onInstall` (auto-migration from the `ELASTICSEARCH_URI` / `BONSAI_URL` env vars to the plugin config namespace `url`), unifying both plugins' configuration path onto the single admin UI. Since Crowi 2.0 is in alpha development and not yet in production, there is no backward-compat fallback; operators set the url in the admin UI, then build the initial index with `crowi-admin search rebuild`. Accordingly, the `ELASTICSEARCH_URI` references were removed from `.env.example` / `docker-compose.yml` / related docs.

### Patch Changes

- Updated dependencies [a52d03f]
- Updated dependencies [966d133]
- Updated dependencies [7f77407]
  - @crowi/plugin-api@0.1.0-alpha.0
