# @crowi/plugin-search-mongo

## 0.1.0-alpha.3

### Patch Changes

- e0dd589: Migrate the last 4 eslintrc-based configs (the repo root, `@crowi/api`, `@crowi/collab`, `@crowi/plugin-search-mongo`) to flat config (`eslint.config.mjs`), so every workspace in the repo now lints through the same config format that `@crowi/web` and `@crowi/site` already used. `eslint` itself moves into the pnpm catalog at `^9.39.5`, so all 7 linted workspaces share one version instead of the previous 8.57.1/9 split.

  This is dev tooling only — no runtime behavior, public type, or API shape changes. Every workspace's lint output was diffed line-by-line against the pre-migration baseline and came back identical (0 errors, same warnings, same files, same line numbers), including `@crowi/api`'s guard rules that block ad hoc test-file DB connections and direct Redis `.duplicate()` calls outside the one helper that installs an error listener first — those guards were restructured from 3 eslintrc override blocks down to 2 flat-config entries (flat config turned out to share eslintrc's "later config replaces, not merges, a repeated rule key" behavior, so the restructuring is a smaller version of the same workaround, not a different one) and their existing regression test (`packages/api/src/test/eslint-db-guard.test.ts`) still passes unmodified assertion-for-assertion, now driving the real flat config via ESLint's Node API with `cwd`-only discovery instead of the removed `useEslintrc` option.

  `eslint` stays on the 9.x series rather than moving to 10: `eslint-config-next` (used by `@crowi/web` and `@crowi/site`) pins `eslint-plugin-react`, whose latest release (7.37.5) calls two APIs ESLint 10 removed outright, so linting a `.tsx` file crashes rather than warns. There is currently no published `eslint-config-next` release that resolves this. Flat config is unaffected by that gap — ESLint 9 already reads it natively — so this migration removes eslintrc from the repo entirely without waiting on the upstream fix; bumping to ESLint 10 later is a single catalog version change once `eslint-plugin-react` supports it.

- ba38a7e: Upgrade `jest` / `@types/jest` / `jest-environment-node` from the 29.x series to 30.5.0 / 30.0.0 / 30.5.0 across the 16 workspaces that share these versions through the pnpm catalog. `ts-jest` stays on 29.4.12 (already accepts `jest@^30`) and `packages/web`'s vitest stack is untouched — this is a test-tooling-only change with no observable behavior difference for users of any of these packages.

  `@crowi/api`'s three custom Jest extension points (the `CrowiEnvironment` test environment's `handleTestEvent`, the `FailureTaxonomyReporter`'s `onTestResult`/`onRunComplete`, and `globalSetup`'s MongoDB connection resolution) were individually verified against jest 30 and continue to work unchanged, as does the `--no-sparkplug` Node 24 V8 workaround the api's test script depends on.

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

## 0.1.0-alpha.2

### Patch Changes

- 8ff0e64: Narrow the plugin SDK's trust boundary: remove `ctx.crypto` and gate `ctx.model()` behind a declared allow-list.

  BREAKING (`@crowi/plugin-api`): `PluginContext.crypto` (and the `PluginCrypto` type) is removed. It exposed the same global `CROWI_ENCRYPTION_KEY`-derived encrypt/decrypt used for core's sensitive Config and every other plugin's `@sensitive` fields, so any installed plugin could decrypt any other plugin's or core's secrets. No first-party plugin used it — the legitimate way to read a plugin's own `@sensitive` config values is unchanged: `ctx.config<T>()` already returns them transparently decrypted.

  `ctx.model(name)` now requires the plugin to declare the model in a new `CrowiPlugin.modelAccess?: string[]` field (same shape as `requires`). Calling `ctx.model()` for an undeclared model throws `Plugin '<name>' called model('<requested>') but did not declare it in 'modelAccess'.` A model listed in `modelAccess` still gets full (unrestricted) read/write access — there is no read-only mode yet. `PluginManager.activate()` validates every declared model name against the registered core models at boot and fails loudly (isolating just that plugin, same as a bad `configSchema`) on an unknown name.

  `GET /admin/plugins` now includes each plugin's declared `modelAccess` in `PluginInfo`, so an admin can audit which plugins touch which core collections.

  The four first-party plugins that call `ctx.model()` (`@crowi/plugin-search-elasticsearch`, `@crowi/plugin-search-mongo`, `@crowi/plugin-search-opensearch`, `@crowi/plugin-slack`) now declare their actual (read-only) usage: `['Page', 'Bookmark', 'User']` for the ES/OpenSearch drivers, `['Page', 'Revision']` for the Mongo driver, `['Page']` for Slack.

- Updated dependencies [336eec1]
- Updated dependencies [8ff0e64]
- Updated dependencies [b20ff59]
- Updated dependencies [d611836]
- Updated dependencies [5e857f6]
  - @crowi/plugin-api@1.0.0-alpha.3

## 0.1.0-alpha.1

### Patch Changes

- ff63cd1: Declare an explicit `zod` peer dependency range (`^4`) instead of `catalog:`. pnpm does not resolve the `catalog:` protocol inside `peerDependencies` during a workspace/source install, so building Crowi from source emitted a spurious `unmet peer zod@catalog:` warning for every plugin. Published packages were already correct (pnpm rewrites `catalog:` to a concrete range on publish), so npm consumers were unaffected — this only silences the noisy source/Docker-build install. Declaring `^4` also more honestly states that the plugins are compatible with any zod 4.x the host application provides.
- Updated dependencies [ff63cd1]
  - @crowi/plugin-api@0.1.0-alpha.1

## 0.1.0-alpha.0

### Minor Changes

- f56fd9b: Added a new plugin `@crowi/plugin-search-mongo`, an infra-free search backend that needs nothing but MongoDB. Adding the plugin name to `plugins[]` in `crowi.config.json` and setting `search.driver: 'mongo'` makes search run as a live MongoDB `$regex` query over page path / title / body, so small-to-mid deployments can use full-text-ish search without standing up Elasticsearch or OpenSearch.

  The driver is grant-aware (anonymous viewers see public pages only; non-admin viewers see public pages plus their own and pages granted to them; admins see everything; draft / deleted / redirect pages are always excluded), and supports `pageType` (portal / public / user), `pathPrefix` filtering and paging (`page` / `limit`, capped at 200). Because it queries live data there is no index to build or maintain: `index()` / `remove()` are no-ops. Body matches are resolved against the current revision in a bulk pass with a candidate cap to keep collection scans bounded; this is positioned for small-to-mid wikis, while large deployments should keep using the Elasticsearch / OpenSearch plugins.

### Patch Changes

- Updated dependencies [a52d03f]
- Updated dependencies [966d133]
- Updated dependencies [7f77407]
  - @crowi/plugin-api@0.1.0-alpha.0
