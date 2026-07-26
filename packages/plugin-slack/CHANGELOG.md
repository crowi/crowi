# @crowi/plugin-slack

## 0.1.0-alpha.2

### Patch Changes

- b0e2c76: Bump dependencies to clear Dependabot security advisories (alerts #622/#623/#626-#637).

  - `sharp` 0.34.5 → 0.35.3, direct in `@crowi/api` (GHSA sharp <0.35.0). Also
    overridden repo-wide (`sharp@<0.35.3` → `0.35.3`) since Next.js pins an
    optional `sharp: ^0.34.5` dependency of its own that a Next.js version bump
    can't escape.
  - `@hono/node-server` 2.0.3 → 2.0.11, direct in `@crowi/api` (GHSA-frvp-7c67-39w9
    path traversal / GHSA-9mqv-5hh9-4cgg WS handshake DoS). Also overridden
    (`@hono/node-server@<2.0.11` → `2.0.11`) for the transitive 1.19.14
    resolution pulled in by `@modelcontextprotocol/sdk`'s own `dependencies` —
    verified crowi never imports the SDK module that requires it
    (`@hono/mcp`'s `StreamableHTTPTransport` mounts into our own existing Hono
    app/server instead), so this resolution was unreachable dead code, but the
    override closes the alert cleanly regardless.
  - `hono` bumped to 4.12.31 (within the existing `^4.12.25` range) across
    `@crowi/api` / `@crowi/api-contract` / `@crowi/plugin-api` / `@crowi/plugin-slack`.
  - `js-yaml` overridden to `3.15.0` / `4.3.0` per major line
    (`js-yaml@>=3.0.0 <3.15.0` / `js-yaml@>=4.0.0 <4.3.0`) — covers every
    transitive consumer (jest/istanbul's 3.x chain, eslint 8/9, changesets,
    the mjml/htmlnano chain, fumadocs, `@redocly/openapi-core`) plus
    `@crowi/api-contract`'s own direct `js-yaml` dependency, bumped to `^4.3.0`.
  - `svgo` and `fast-uri` overridden to `4.0.2` / `3.1.4` — their parents
    (`htmlnano`, `ajv`) already declare wide-enough ranges to permit the
    patched versions but pnpm won't re-resolve a pure-transitive package
    within an already-satisfied range without a forcing mechanism.

  The sharp 0.35 bump changed its TypeScript declarations from the old
  namespace-merged `sharp.Sharp`/`sharp.Metadata`/`sharp.OutputInfo` pattern to
  named exports; `image-display-derivative.ts` updated its type imports
  accordingly (no behavior change). It also surfaced a latent bug in this
  package's own test fixture (an ancillary PNG chunk type `padA` with a
  lowercase reserved-bit byte, which is not PNG-spec-conformant — sharp 0.34's
  bundled `spng` PNG decoder tolerated it, 0.35's `libpng`-backed decoder
  correctly rejects it); the fixture was corrected to `paDA`, no production
  code changed.

- Updated dependencies [df1ce77]
- Updated dependencies [05648c0]
- Updated dependencies [d680c0c]
- Updated dependencies [a32204f]
- Updated dependencies [b0e2c76]
  - @crowi/plugin-api@1.0.0-alpha.4

## 0.1.0-alpha.1

### Patch Changes

- 8ff0e64: Narrow the plugin SDK's trust boundary: remove `ctx.crypto` and gate `ctx.model()` behind a declared allow-list.

  BREAKING (`@crowi/plugin-api`): `PluginContext.crypto` (and the `PluginCrypto` type) is removed. It exposed the same global `CROWI_ENCRYPTION_KEY`-derived encrypt/decrypt used for core's sensitive Config and every other plugin's `@sensitive` fields, so any installed plugin could decrypt any other plugin's or core's secrets. No first-party plugin used it — the legitimate way to read a plugin's own `@sensitive` config values is unchanged: `ctx.config<T>()` already returns them transparently decrypted.

  `ctx.model(name)` now requires the plugin to declare the model in a new `CrowiPlugin.modelAccess?: string[]` field (same shape as `requires`). Calling `ctx.model()` for an undeclared model throws `Plugin '<name>' called model('<requested>') but did not declare it in 'modelAccess'.` A model listed in `modelAccess` still gets full (unrestricted) read/write access — there is no read-only mode yet. `PluginManager.activate()` validates every declared model name against the registered core models at boot and fails loudly (isolating just that plugin, same as a bad `configSchema`) on an unknown name.

  `GET /admin/plugins` now includes each plugin's declared `modelAccess` in `PluginInfo`, so an admin can audit which plugins touch which core collections.

  The four first-party plugins that call `ctx.model()` (`@crowi/plugin-search-elasticsearch`, `@crowi/plugin-search-mongo`, `@crowi/plugin-search-opensearch`, `@crowi/plugin-slack`) now declare their actual (read-only) usage: `['Page', 'Bookmark', 'User']` for the ES/OpenSearch drivers, `['Page', 'Revision']` for the Mongo driver, `['Page']` for Slack.

- b20ff59: Plugin SDK: `PluginRouteOptions.public?: boolean` is replaced by `auth?: 'public' | 'user' | 'admin'` (default `'user'`). `makePluginRouterScope` now installs `createJwtAdminRequired` — the same middleware every core `/admin/*` handler uses — for `auth: 'admin'` routes, so plugins finally have a real admin-only tier instead of only "no auth" / "any authenticated user".

  BREAKING (pre-1.0 SDK): plugins passing `{ public: true }` must switch to `{ auth: 'public' }`; the `public` field no longer exists on `PluginRouteOptions`.

  Fixes a real gap in `@crowi/plugin-slack`: its `POST /manifest` `@action` target (which returns the Slack App manifest, including the wiki's base URL and name) was documented as admin-only but was actually reachable by any authenticated non-admin user. It is now mounted with `auth: 'admin'` and returns `403 ADMIN_REQUIRED` for non-admin users. The Events API webhook keeps `auth: 'public'` (Slack's own request-signature check is its authentication).

  Also narrows `@action` annotation parsing (`schema-markers.ts`) to the two verbs a plugin route can actually be mounted on (`GET` / `POST` — `PluginRouteMethod`), so a plugin declaring `@action "..." PUT ...` / `DELETE` no longer produces a silently-dead admin-form button: `getActionAnnotation` still returns `null` for it, and `PluginManager` now logs a boot-time warning identifying the offending plugin and config field.

- Updated dependencies [336eec1]
- Updated dependencies [8ff0e64]
- Updated dependencies [b20ff59]
- Updated dependencies [d611836]
- Updated dependencies [5e857f6]
  - @crowi/plugin-api@1.0.0-alpha.3

## 0.1.0-alpha.0

### Minor Changes

- 2f70464: New `@crowi/plugin-slack`: rich link unfurling of public Crowi pages in Slack.
  Generates a Slack App manifest from admin, verifies inbound Slack request
  signatures, handles the Events API `url_verification` handshake, and unfurls
  `link_shared` for public pages (title / breadcrumb / excerpt / updated-at);
  non-public pages render a locked placeholder with no body.

### Patch Changes

- Updated dependencies [66f1de2]
- Updated dependencies [e9aad03]
  - @crowi/plugin-api@0.1.0-alpha.2
