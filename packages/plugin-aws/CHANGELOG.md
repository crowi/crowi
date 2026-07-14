# @crowi/plugin-aws

## 0.1.0-alpha.2

### Patch Changes

- 336eec1: Close two residual paths from the plugin SDK's trust boundary to core/other-plugin secrets, making the "a plugin cannot reach another plugin's or core's secrets through PluginContext" claim true rather than aspirational.

  BREAKING (`@crowi/plugin-api`): credential-vault core models (`Config`, `PersonalAccessToken`, `OAuthClient`, `OAuthAuthorizationCode`, `OAuthDeviceCode`, `OAuthRefreshToken`, `Share`, `ShareAccess`) can no longer be listed in `CrowiPlugin.modelAccess` at all — declaring one now fails boot with a descriptive error (`PluginManager.activate()`'s `assertValidModelAccess()`), and `ctx.model()` also refuses to return one at call time as defense-in-depth. Previously any plugin could declare `modelAccess: ['Config']` and read every core/plugin `@sensitive` value in decrypted form, or read/write `PersonalAccessToken` / OAuth token rows directly — there was no legitimate plugin use case for this, so no first-party plugin is affected.

  BREAKING (`@crowi/plugin-api`): `ctx.dependencyConfig(name)` now also requires the target plugin to opt in with a new `CrowiPlugin.exposesConfigToDependents?: boolean` field. Previously, listing a dependency in `requires` was sufficient to read its decrypted config (`@sensitive` fields included) — a plugin could self-declare `requires: ['@crowi/plugin-aws']` and read AWS credentials without `@crowi/plugin-aws`'s consent. `@crowi/plugin-aws` now declares `exposesConfigToDependents: true` (its whole purpose is sharing credentials with `@crowi/plugin-storage-aws-s3` / `@crowi/plugin-mail-aws-ses`), so that existing dependency chain keeps working unchanged; any other plugin that depended on this implicit access would need to add the flag.

  The `PluginContext` trust-boundary doc (`packages/plugin-api/src/context.ts`), `CrowiPlugin`'s TSDoc, and the plugins developing guide (ja/en) are updated to state the now-true claims, plus the one remaining honest caveat: `modelAccess: ['User']` still returns the raw document (password hash included) — field projection is deferred to a post-2.0 repository/HTTP layer separation.

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
