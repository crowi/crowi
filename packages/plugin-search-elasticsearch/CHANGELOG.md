# @crowi/plugin-search-elasticsearch

## 0.1.0-alpha.2

### Patch Changes

- ff63cd1: Declare an explicit `zod` peer dependency range (`^4`) instead of `catalog:`. pnpm does not resolve the `catalog:` protocol inside `peerDependencies` during a workspace/source install, so building Crowi from source emitted a spurious `unmet peer zod@catalog:` warning for every plugin. Published packages were already correct (pnpm rewrites `catalog:` to a concrete range on publish), so npm consumers were unaffected — this only silences the noisy source/Docker-build install. Declaring `^4` also more honestly states that the plugins are compatible with any zod 4.x the host application provides.
- Updated dependencies [ff63cd1]
  - @crowi/plugin-api@0.1.0-alpha.1

## 0.1.0-alpha.1

### Patch Changes

- 3e58ee8: Bump dependencies to clear Dependabot security advisories. Direct deps lifted so
  transitive chains resolve to the patched versions:

  - `hono` 4.10.0 → 4.12.25 (GHSA-88fw-hqm2-52qc / GHSA-rv63-4mwf-qqc2 /
    GHSA-wgpf-jwqj-8h8p / GHSA-wwfh-h76j-fc44 / GHSA-j6c9-x7qj-28xf)
  - `ws` 8.20.1 → 8.21.0 (GHSA-96hv-2xvq-fx4p)
  - `@elastic/elasticsearch` 9.4.0 → 9.4.2 — pulls `@elastic/transport` 9.3.7 and
    `@opentelemetry/core` 2.8.0 (GHSA-8988-4f7v-96qf)
  - `fumadocs-core` / `fumadocs-mdx` / `fumadocs-ui` to their 16.10.4 / 15.0.12
    lines, `eslint-config-next` 16.1.1 → 16.2.9, `vitest` 4.1.6 → 4.1.9,
    `@vitejs/plugin-react` 6.0.1 → 6.0.2 — pull `@babel/core` 7.29.7 and
    `esbuild` 0.28.1 (GHSA-4x5r-pxfx-6jf8 / GHSA-g7r4-m6w7-qqqr)
  - `form-data` ^4.0.6 and `vite` ^8.0.16 lifted into the dev dependencies of
    `packages/api` / `packages/web` / `apps/crowi-site` so the lockfile resolver
    picks the patched range that supertest / vitest / fumadocs-mdx /
    `@vitejs/plugin-react` could not reach via peer constraints alone (form-data:
    GHSA-hmw2-7cc7-3qxx; vite: GHSA-fx2h-pf6j-xcff / GHSA-v6wh-96g9-6wx3).

  The remaining `js-yaml` (eslint 8 chain) and `ip-address` (mongoose 8 →
  mongodb → socks chain) advisories require eslint 8 → 9 and mongoose 8 → 9
  major upgrades respectively; tracked in TODO.md.

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
