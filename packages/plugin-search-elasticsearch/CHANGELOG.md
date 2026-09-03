# @crowi/plugin-search-elasticsearch

## 0.1.0-alpha.6

### Patch Changes

- ba38a7e: Upgrade `jest` / `@types/jest` / `jest-environment-node` from the 29.x series to 30.5.0 / 30.0.0 / 30.5.0 across the 16 workspaces that share these versions through the pnpm catalog. `ts-jest` stays on 29.4.12 (already accepts `jest@^30`) and `packages/web`'s vitest stack is untouched — this is a test-tooling-only change with no observable behavior difference for users of any of these packages.

  `@crowi/api`'s three custom Jest extension points (the `CrowiEnvironment` test environment's `handleTestEvent`, the `FailureTaxonomyReporter`'s `onTestResult`/`onRunComplete`, and `globalSetup`'s MongoDB connection resolution) were individually verified against jest 30 and continue to work unchanged, as does the `--no-sparkplug` Node 24 V8 workaround the api's test script depends on.

- Updated dependencies [ba38a7e]
- Updated dependencies [a334308]
  - @crowi/plugin-api@1.0.0-alpha.9

## 0.1.0-alpha.5

### Minor Changes

- c810729: Saving local storage, AWS S3, or Elasticsearch configuration from `/admin/plugins` now runs a non-blocking connectivity/permission check right after the existing save and hot-reload finish. Local and S3 do a real `put` / `get` / `delete` round trip under a reserved key namespace, entirely separate from uploaded attachments; Elasticsearch calls the cluster's `info` API once. The admin UI shows the outcome next to the existing save toast — "saved, but verification failed" with one of a small set of fixed reasons (unreachable, authentication failed, not found, write denied, unknown) — without ever undoing the save; a failed check is informational only.

  The check always reflects just the api instance that answered the save request, never a cluster-wide result, and every form control (including the linked-identities confirmation dialog) is disabled while a save is in flight so edits can't race the response.

  Plugin authors can opt into the same mechanism via the new optional `CrowiPlugin.verifyConfig` hook in `@crowi/plugin-api`, documented in that package's README.

### Patch Changes

- Updated dependencies [c810729]
  - @crowi/plugin-api@1.0.0-alpha.8

## 0.1.0-alpha.4

### Minor Changes

- c5f243a: Admins now see a non-blocking warning banner (on every wiki page and in `/admin/plugins`) when the currently selected storage or search driver is missing configuration it needs to actually work — such as the S3 bucket name, or the Elasticsearch/OpenSearch cluster URL — so misconfiguration is caught before it causes an upload or search failure instead of only surfacing as a 500 later.

  - New `CrowiPlugin.readiness` SDK declaration lets a plugin state which of its own config fields must be set once a specific driver is selected; `@crowi/plugin-storage-aws-s3` (`bucket`), `@crowi/plugin-search-elasticsearch`, and `@crowi/plugin-search-opensearch` (`url`) declare it.
  - New admin-only `GET /admin/plugins/readiness` endpoint reports only the plugin name, its admin placement, and the unset field names — never the actual config value, URL, or any secret.
  - The wiki header and the `/admin/plugins` list link straight to the affected plugin's config screen; saving the missing field clears the warning on the next refetch.
  - Non-admins never see the banner and never trigger the readiness request.

### Patch Changes

- Updated dependencies [c5f243a]
- Updated dependencies [8b42663]
  - @crowi/plugin-api@1.0.0-alpha.6

## 0.1.0-alpha.3

### Patch Changes

- 8ff0e64: Narrow the plugin SDK's trust boundary: remove `ctx.crypto` and gate `ctx.model()` behind a declared allow-list.

  BREAKING (`@crowi/plugin-api`): `PluginContext.crypto` (and the `PluginCrypto` type) is removed. It exposed the same global `CROWI_ENCRYPTION_KEY`-derived encrypt/decrypt used for core's sensitive Config and every other plugin's `@sensitive` fields, so any installed plugin could decrypt any other plugin's or core's secrets. No first-party plugin used it — the legitimate way to read a plugin's own `@sensitive` config values is unchanged: `ctx.config<T>()` already returns them transparently decrypted.

  `ctx.model(name)` now requires the plugin to declare the model in a new `CrowiPlugin.modelAccess?: string[]` field (same shape as `requires`). Calling `ctx.model()` for an undeclared model throws `Plugin '<name>' called model('<requested>') but did not declare it in 'modelAccess'.` A model listed in `modelAccess` still gets full (unrestricted) read/write access — there is no read-only mode yet. `PluginManager.activate()` validates every declared model name against the registered core models at boot and fails loudly (isolating just that plugin, same as a bad `configSchema`) on an unknown name.

  `GET /admin/plugins` now includes each plugin's declared `modelAccess` in `PluginInfo`, so an admin can audit which plugins touch which core collections.

  The four first-party plugins that call `ctx.model()` (`@crowi/plugin-search-elasticsearch`, `@crowi/plugin-search-mongo`, `@crowi/plugin-search-opensearch`, `@crowi/plugin-slack`) now declare their actual (read-only) usage: `['Page', 'Bookmark', 'User']` for the ES/OpenSearch drivers, `['Page', 'Revision']` for the Mongo driver, `['Page']` for Slack.

- d611836: Plugin SDK: add a hot-reload `StateCell<T>` primitive, exposed as `ctx.state<T>(initial)` on `PluginContext`. It gives `reconfigure`-implementing driver plugins (storage / search / mail sending) a structured way to hold a swappable resource (an SDK client, a connection pool) instead of hand-rolling module-scope mutable state: `get()`/`withValue()` read the current value, and `set(next, { dispose })` swaps in a new one — `dispose(prev)` only runs once every `withValue()` call in flight against the previous value has settled, so a resource still in use is never torn down under a caller. For the same plugin, every `PluginContext` instance (the activation-time `ctx` and every later `reconfigure(ctx)`) shares the same cell.

  `@crowi/plugin-storage-aws-s3`, `@crowi/plugin-mail-smtp`, and `@crowi/plugin-search-elasticsearch` are migrated onto this primitive. Each now explicitly disposes the resource `reconfigure` replaces — `S3Client.destroy()`, `Transporter.close()`, and the Elasticsearch `Client.close()` respectively — fixing a connection leak on every hot-reload. The Elasticsearch driver's client close is also no longer fire-and-forget the instant `reconfigure` returns: it now waits for any in-flight search/index/remove/rebuild call still using the old client to finish first.

- fa5023f: `GRANT_RESTRICTED` ("Anyone with the link") pages now actually work like a link-share invite. Opening a restricted page's id URL (`/<page._id>`, and the revived legacy `/_r/<page._id>` short link) via `IdRedirector` adds the visitor to the page's `grantedUsers` on first visit, so a follow-up direct visit to the page's real path — or from the list/search — no longer 404s. Previously `GRANT_RESTRICTED` behaved like `GRANT_SPECIFIED` for anyone who hadn't already been added, silently breaking the promise made by the link-share popover. A permanent banner now appears at the top of a `GRANT_RESTRICTED` page (hidden for wip/deprecated/draft/stale-revision views, where the link wouldn't actually be claimable) that honestly states sharing the URL below invites the recipient as an editor, with a copy-to-clipboard control and no dismiss option.

  The grant-on-first-access write is confined to a new `POST /pages/link-access` endpoint called only by `IdRedirector`: it is web-session only (OAuth/PAT tokens are rejected before the per-user rate limiter counts them), rate-limited at 30 req/min/user, and atomic (a concurrent grant change or soft-delete can never be raced into an invite). `GET /pages?page_id=` and every other by-id caller (`/_edit`, `/_attachments`, comment/bookmark/watch helpers) are unchanged — visiting those does not grant access.

  Also fixes a search-index visibility gap surfaced while implementing this: search results could include stale hits for soft-deleted / redirect-stub pages, and the Elasticsearch/OpenSearch drivers now exclude `wip` / `deprecated` pages from the index (matching list visibility) instead of leaving them as permanent dead hits.

- Updated dependencies [336eec1]
- Updated dependencies [8ff0e64]
- Updated dependencies [b20ff59]
- Updated dependencies [d611836]
- Updated dependencies [5e857f6]
  - @crowi/plugin-api@1.0.0-alpha.3

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
  major upgrades respectively.

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
