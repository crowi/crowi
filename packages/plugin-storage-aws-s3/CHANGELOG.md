# @crowi/plugin-storage-aws-s3

## 0.1.0-alpha.5

### Patch Changes

- a334308: Upgrade TypeScript 5.8 → 6.0 across the whole workspace catalog, plus the two tools whose own peer ranges gated it: `ts-jest` 29.3 → 29.4 (the current version still excluded TS 6) and `@typescript-eslint` 6.21 → 8.68 (moved into the catalog so all five workspaces that declare it directly stay in lockstep). `eslint` itself is untouched, jest stays on the same major, and TypeScript 7 (a native/Go rewrite still landing ecosystem-wide support) is out of scope — this bump is the sanctioned bridge release for that eventual move.

  Runtime behavior and every public type/API shape are unchanged; the generated `.d.ts` output was diffed against the pre-upgrade build across all 316 declaration files and the only differences found were union-member reordering (an internal declaration-emitter artifact, byte-identical content once sorted) with zero content changes.

  Two compiler-level fallouts were absorbed without weakening `strict` or any other type-safety setting:

  - TS 6 hard-errors on two now-deprecated `tsconfig` options that will disappear in TS 7 (`moduleResolution: "node"` and any `baseUrl`, the latter also implicitly injected by `tsup`'s own declaration bundler on every workspace that ships a `.d.ts`). The shared `tsconfig/base.json` now sets `ignoreDeprecations: "6.0"`, which is TypeScript's own documented bridge flag for this exact transitional release; actually migrating off these options is real resolution-strategy work that belongs with the eventual TS 7 move, not this version bump.
  - TS 6 stopped auto-including `@types/*` packages for workspaces using `moduleResolution: "bundler"` unless a tsconfig's `types` array names them explicitly. Several `library.json`-based packages picked up this newly-required `types: ["node"]` / `types: ["jest", "node"]`, matching the explicit-`types` convention several sibling packages (`svg-sanitize`, `admin-cli`, the search plugins, etc.) already used for the same reason.

  `@typescript-eslint` 8's `recommended` preset also added `no-require-imports` (superseding the deprecated `no-var-requires` most call sites already had a justified `eslint-disable` comment for) and tightened `no-empty-object-type` against empty `interface X extends Y {}` declarations. Every new diagnostic was resolved individually: existing suppression comments were extended to cover the new rule name, a handful of genuinely dead/redundant `require()` calls were deleted, two `require()` calls were converted to static imports, and three `Pick<...>`-only marker interfaces became plain type aliases (a mechanical, meaning-preserving rewrite, not a design change).

  `@crowi/web` and `@crowi/site` lint through `eslint-config-next`, which bundles its own `typescript-eslint` dependency rather than reading the workspace catalog. That bundled copy (8.53.0) declared `typescript: >=4.8.4 <6.0.0`, a TS6-excluding range. A `pnpm.overrides` entry (`"typescript-eslint@<8.68.0": "8.68.0"`) forces it to the same 8.68.0 already used directly by the five workspaces above, whose peer range (`>=4.8.4 <6.1.0`) accepts TS 6. No new lint errors surfaced in either workspace after the bump.

  One TS6-excluding tool remains in the graph with no available fix: `openapi-typescript` 7.13.0 (used only by `@crowi/api-contract`'s dev-time OpenAPI-types codegen script, `scripts/generate-openapi-types.ts`) declares `typescript: ^5.x`, and 7.13.0 is still the latest release. This surfaces only as a non-fatal `pnpm install` peer-dependency warning — pnpm does not fail installs on unmet peers by default, and the tool isn't part of `type-check` / `build` / `test` / `lint`. It was verified functionally: `pnpm --filter @crowi/api-contract generate` runs clean under TS 6, and `pnpm check:openapi` confirms the regenerated artifacts are byte-identical to the committed ones. Revisit once openapi-typescript ships a TS6-compatible release.

- Updated dependencies [ba38a7e]
- Updated dependencies [a334308]
  - @crowi/plugin-api@1.0.0-alpha.9

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
