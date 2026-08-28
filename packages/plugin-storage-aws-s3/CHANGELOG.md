# @crowi/plugin-storage-aws-s3

## 0.1.0-alpha.4

### Minor Changes

- c810729: Saving local storage, AWS S3, or Elasticsearch configuration from `/admin/plugins` now runs a non-blocking connectivity/permission check right after the existing save and hot-reload finish. Local and S3 do a real `put` / `get` / `delete` round trip under a reserved key namespace, entirely separate from uploaded attachments; Elasticsearch calls the cluster's `info` API once. The admin UI shows the outcome next to the existing save toast — "saved, but verification failed" with one of a small set of fixed reasons (unreachable, authentication failed, not found, write denied, unknown) — without ever undoing the save; a failed check is informational only.

  The check always reflects just the api instance that answered the save request, never a cluster-wide result, and every form control (including the linked-identities confirmation dialog) is disabled while a save is in flight so edits can't race the response.

  Plugin authors can opt into the same mechanism via the new optional `CrowiPlugin.verifyConfig` hook in `@crowi/plugin-api`, documented in that package's README.

### Patch Changes

- Updated dependencies [c810729]
  - @crowi/plugin-api@1.0.0-alpha.8

## 0.1.0-alpha.3

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

## 0.1.0-alpha.2

### Patch Changes

- d611836: Plugin SDK: add a hot-reload `StateCell<T>` primitive, exposed as `ctx.state<T>(initial)` on `PluginContext`. It gives `reconfigure`-implementing driver plugins (storage / search / mail sending) a structured way to hold a swappable resource (an SDK client, a connection pool) instead of hand-rolling module-scope mutable state: `get()`/`withValue()` read the current value, and `set(next, { dispose })` swaps in a new one — `dispose(prev)` only runs once every `withValue()` call in flight against the previous value has settled, so a resource still in use is never torn down under a caller. For the same plugin, every `PluginContext` instance (the activation-time `ctx` and every later `reconfigure(ctx)`) shares the same cell.

  `@crowi/plugin-storage-aws-s3`, `@crowi/plugin-mail-smtp`, and `@crowi/plugin-search-elasticsearch` are migrated onto this primitive. Each now explicitly disposes the resource `reconfigure` replaces — `S3Client.destroy()`, `Transporter.close()`, and the Elasticsearch `Client.close()` respectively — fixing a connection leak on every hot-reload. The Elasticsearch driver's client close is also no longer fire-and-forget the instant `reconfigure` returns: it now waits for any in-flight search/index/remove/rebuild call still using the old client to finish first.

- Updated dependencies [336eec1]
- Updated dependencies [8ff0e64]
- Updated dependencies [b20ff59]
- Updated dependencies [d611836]
- Updated dependencies [5e857f6]
  - @crowi/plugin-api@1.0.0-alpha.3
  - @crowi/plugin-aws@0.1.0-alpha.2

## 0.1.0-alpha.1

### Patch Changes

- ff63cd1: Declare an explicit `zod` peer dependency range (`^4`) instead of `catalog:`. pnpm does not resolve the `catalog:` protocol inside `peerDependencies` during a workspace/source install, so building Crowi from source emitted a spurious `unmet peer zod@catalog:` warning for every plugin. Published packages were already correct (pnpm rewrites `catalog:` to a concrete range on publish), so npm consumers were unaffected — this only silences the noisy source/Docker-build install. Declaring `^4` also more honestly states that the plugins are compatible with any zod 4.x the host application provides.
- Updated dependencies [ff63cd1]
  - @crowi/plugin-api@0.1.0-alpha.1
  - @crowi/plugin-aws@0.1.0-alpha.1

## 0.1.0-alpha.0

### Minor Changes

- a52d03f: Initial publish preparation: monorepo restructure complete (RFC-0002 →
  feature-monorepo-packages-restructure). All packages now use
  workspace: protocol internally, peerDependencies for plugin boundaries,
  shared @crowi/tsconfig presets, and a publish-ready layout under
  packages/\*.

### Patch Changes

- Updated dependencies [a52d03f]
- Updated dependencies [966d133]
- Updated dependencies [7f77407]
  - @crowi/plugin-api@0.1.0-alpha.0
  - @crowi/plugin-aws@0.1.0-alpha.0
