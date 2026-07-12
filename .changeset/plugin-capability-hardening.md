---
"@crowi/plugin-api": major
"@crowi/api": minor
"@crowi/plugin-aws": patch
---

Close two residual paths from the plugin SDK's trust boundary to core/other-plugin secrets, making the "a plugin cannot reach another plugin's or core's secrets through PluginContext" claim true rather than aspirational.

BREAKING (`@crowi/plugin-api`): credential-vault core models (`Config`, `PersonalAccessToken`, `OAuthClient`, `OAuthAuthorizationCode`, `OAuthDeviceCode`, `OAuthRefreshToken`, `Share`, `ShareAccess`) can no longer be listed in `CrowiPlugin.modelAccess` at all — declaring one now fails boot with a descriptive error (`PluginManager.activate()`'s `assertValidModelAccess()`), and `ctx.model()` also refuses to return one at call time as defense-in-depth. Previously any plugin could declare `modelAccess: ['Config']` and read every core/plugin `@sensitive` value in decrypted form, or read/write `PersonalAccessToken` / OAuth token rows directly — there was no legitimate plugin use case for this, so no first-party plugin is affected.

BREAKING (`@crowi/plugin-api`): `ctx.dependencyConfig(name)` now also requires the target plugin to opt in with a new `CrowiPlugin.exposesConfigToDependents?: boolean` field. Previously, listing a dependency in `requires` was sufficient to read its decrypted config (`@sensitive` fields included) — a plugin could self-declare `requires: ['@crowi/plugin-aws']` and read AWS credentials without `@crowi/plugin-aws`'s consent. `@crowi/plugin-aws` now declares `exposesConfigToDependents: true` (its whole purpose is sharing credentials with `@crowi/plugin-storage-aws-s3` / `@crowi/plugin-mail-aws-ses`), so that existing dependency chain keeps working unchanged; any other plugin that depended on this implicit access would need to add the flag.

The `PluginContext` trust-boundary doc (`packages/plugin-api/src/context.ts`), `CrowiPlugin`'s TSDoc, and the plugins developing guide (ja/en) are updated to state the now-true claims, plus the one remaining honest caveat: `modelAccess: ['User']` still returns the raw document (password hash included) — field projection is deferred to a post-2.0 repository/HTTP layer separation.
