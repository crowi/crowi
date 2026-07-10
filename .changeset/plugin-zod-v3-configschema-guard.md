---
"@crowi/api": patch
"@crowi/plugin-api": patch
---

Fail plugin boot loudly when a `configSchema` is built from the wrong zod entry point, instead of silently losing `@sensitive` detection and writing secrets to storage as plaintext.

`@crowi/plugin-api`'s `peerDependencies: { zod: "^4" }` only says which npm package to install; it does not say which entry point to import from, and every config-schema introspection helper (`@sensitive`/`@action` marker detection, the admin form field serializer, `listSensitiveKeys()`) depends on the internal shape of the `zod/v3` compat subpath the v4 package ships. A `configSchema` built from the top-level `zod` (v4) API has a different internal shape that all of that introspection silently fails to walk. `PluginManager.bootstrap()` now validates every loaded plugin's `configSchema` right after resolving plugin order, before it calls `listSensitiveKeys()` (which is itself zod/v3-dependent), and throws a descriptive error naming the offending plugin when it wasn't built from `zod/v3`; `activate()` keeps its own equivalent per-plugin check for direct/private-call coverage. `schema-serializer.ts`'s kind detection also switched from `instanceof z.ZodXxx` to `_def.typeName` string comparisons, which is more robust against duplicate `zod/v3` module copies and gives the same defense in depth. `@crowi/plugin-api` gains a README (previously missing despite `package.json`'s `files` already listing it) documenting this, plus a `configSchema` TSDoc note.
