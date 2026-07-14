# @crowi/plugin-api

## 1.0.0-alpha.3

### Major Changes

- 336eec1: Close two residual paths from the plugin SDK's trust boundary to core/other-plugin secrets, making the "a plugin cannot reach another plugin's or core's secrets through PluginContext" claim true rather than aspirational.

  BREAKING (`@crowi/plugin-api`): credential-vault core models (`Config`, `PersonalAccessToken`, `OAuthClient`, `OAuthAuthorizationCode`, `OAuthDeviceCode`, `OAuthRefreshToken`, `Share`, `ShareAccess`) can no longer be listed in `CrowiPlugin.modelAccess` at all — declaring one now fails boot with a descriptive error (`PluginManager.activate()`'s `assertValidModelAccess()`), and `ctx.model()` also refuses to return one at call time as defense-in-depth. Previously any plugin could declare `modelAccess: ['Config']` and read every core/plugin `@sensitive` value in decrypted form, or read/write `PersonalAccessToken` / OAuth token rows directly — there was no legitimate plugin use case for this, so no first-party plugin is affected.

  BREAKING (`@crowi/plugin-api`): `ctx.dependencyConfig(name)` now also requires the target plugin to opt in with a new `CrowiPlugin.exposesConfigToDependents?: boolean` field. Previously, listing a dependency in `requires` was sufficient to read its decrypted config (`@sensitive` fields included) — a plugin could self-declare `requires: ['@crowi/plugin-aws']` and read AWS credentials without `@crowi/plugin-aws`'s consent. `@crowi/plugin-aws` now declares `exposesConfigToDependents: true` (its whole purpose is sharing credentials with `@crowi/plugin-storage-aws-s3` / `@crowi/plugin-mail-aws-ses`), so that existing dependency chain keeps working unchanged; any other plugin that depended on this implicit access would need to add the flag.

  The `PluginContext` trust-boundary doc (`packages/plugin-api/src/context.ts`), `CrowiPlugin`'s TSDoc, and the plugins developing guide (ja/en) are updated to state the now-true claims, plus the one remaining honest caveat: `modelAccess: ['User']` still returns the raw document (password hash included) — field projection is deferred to a post-2.0 repository/HTTP layer separation.

- 8ff0e64: Narrow the plugin SDK's trust boundary: remove `ctx.crypto` and gate `ctx.model()` behind a declared allow-list.

  BREAKING (`@crowi/plugin-api`): `PluginContext.crypto` (and the `PluginCrypto` type) is removed. It exposed the same global `CROWI_ENCRYPTION_KEY`-derived encrypt/decrypt used for core's sensitive Config and every other plugin's `@sensitive` fields, so any installed plugin could decrypt any other plugin's or core's secrets. No first-party plugin used it — the legitimate way to read a plugin's own `@sensitive` config values is unchanged: `ctx.config<T>()` already returns them transparently decrypted.

  `ctx.model(name)` now requires the plugin to declare the model in a new `CrowiPlugin.modelAccess?: string[]` field (same shape as `requires`). Calling `ctx.model()` for an undeclared model throws `Plugin '<name>' called model('<requested>') but did not declare it in 'modelAccess'.` A model listed in `modelAccess` still gets full (unrestricted) read/write access — there is no read-only mode yet. `PluginManager.activate()` validates every declared model name against the registered core models at boot and fails loudly (isolating just that plugin, same as a bad `configSchema`) on an unknown name.

  `GET /admin/plugins` now includes each plugin's declared `modelAccess` in `PluginInfo`, so an admin can audit which plugins touch which core collections.

  The four first-party plugins that call `ctx.model()` (`@crowi/plugin-search-elasticsearch`, `@crowi/plugin-search-mongo`, `@crowi/plugin-search-opensearch`, `@crowi/plugin-slack`) now declare their actual (read-only) usage: `['Page', 'Bookmark', 'User']` for the ES/OpenSearch drivers, `['Page', 'Revision']` for the Mongo driver, `['Page']` for Slack.

### Minor Changes

- b20ff59: Plugin SDK: `PluginRouteOptions.public?: boolean` is replaced by `auth?: 'public' | 'user' | 'admin'` (default `'user'`). `makePluginRouterScope` now installs `createJwtAdminRequired` — the same middleware every core `/admin/*` handler uses — for `auth: 'admin'` routes, so plugins finally have a real admin-only tier instead of only "no auth" / "any authenticated user".

  BREAKING (pre-1.0 SDK): plugins passing `{ public: true }` must switch to `{ auth: 'public' }`; the `public` field no longer exists on `PluginRouteOptions`.

  Fixes a real gap in `@crowi/plugin-slack`: its `POST /manifest` `@action` target (which returns the Slack App manifest, including the wiki's base URL and name) was documented as admin-only but was actually reachable by any authenticated non-admin user. It is now mounted with `auth: 'admin'` and returns `403 ADMIN_REQUIRED` for non-admin users. The Events API webhook keeps `auth: 'public'` (Slack's own request-signature check is its authentication).

  Also narrows `@action` annotation parsing (`schema-markers.ts`) to the two verbs a plugin route can actually be mounted on (`GET` / `POST` — `PluginRouteMethod`), so a plugin declaring `@action "..." PUT ...` / `DELETE` no longer produces a silently-dead admin-form button: `getActionAnnotation` still returns `null` for it, and `PluginManager` now logs a boot-time warning identifying the offending plugin and config field.

- d611836: Plugin SDK: add a hot-reload `StateCell<T>` primitive, exposed as `ctx.state<T>(initial)` on `PluginContext`. It gives `reconfigure`-implementing driver plugins (storage / search / mail sending) a structured way to hold a swappable resource (an SDK client, a connection pool) instead of hand-rolling module-scope mutable state: `get()`/`withValue()` read the current value, and `set(next, { dispose })` swaps in a new one — `dispose(prev)` only runs once every `withValue()` call in flight against the previous value has settled, so a resource still in use is never torn down under a caller. For the same plugin, every `PluginContext` instance (the activation-time `ctx` and every later `reconfigure(ctx)`) shares the same cell.

  `@crowi/plugin-storage-aws-s3`, `@crowi/plugin-mail-smtp`, and `@crowi/plugin-search-elasticsearch` are migrated onto this primitive. Each now explicitly disposes the resource `reconfigure` replaces — `S3Client.destroy()`, `Transporter.close()`, and the Elasticsearch `Client.close()` respectively — fixing a connection leak on every hot-reload. The Elasticsearch driver's client close is also no longer fire-and-forget the instant `reconfigure` returns: it now waits for any in-flight search/index/remove/rebuild call still using the old client to finish first.

### Patch Changes

- 5e857f6: Fail plugin boot loudly when a `configSchema` is built from the wrong zod entry point, instead of silently losing `@sensitive` detection and writing secrets to storage as plaintext.

  `@crowi/plugin-api`'s `peerDependencies: { zod: "^4" }` only says which npm package to install; it does not say which entry point to import from, and every config-schema introspection helper (`@sensitive`/`@action` marker detection, the admin form field serializer, `listSensitiveKeys()`) depends on the internal shape of the `zod/v3` compat subpath the v4 package ships. A `configSchema` built from the top-level `zod` (v4) API has a different internal shape that all of that introspection silently fails to walk. `PluginManager.bootstrap()` now validates every loaded plugin's `configSchema` right after resolving plugin order, before it calls `listSensitiveKeys()` (which is itself zod/v3-dependent), and throws a descriptive error naming the offending plugin when it wasn't built from `zod/v3`; `activate()` keeps its own equivalent per-plugin check for direct/private-call coverage. `schema-serializer.ts`'s kind detection also switched from `instanceof z.ZodXxx` to `_def.typeName` string comparisons, which is more robust against duplicate `zod/v3` module copies and gives the same defense in depth. `@crowi/plugin-api` gains a README (previously missing despite `package.json`'s `files` already listing it) documenting this, plus a `configSchema` TSDoc note.

## 0.1.0-alpha.2

### Minor Changes

- 66f1de2: Plugin SDK: add `ctx.appInfo()` to `PluginContext`. It exposes core application info a plugin may need to brand or address outbound integrations — `title` (the configured wiki name, core `app:title`, trimmed and defaulted to `Crowi`) and `baseUrl` (the wiki's public origin, core `CLIENT_URL` / `getBaseUrl()`, empty string when unset). Both fields are non-null, so plugins read them instead of `process.env` directly without writing their own fallbacks; read live at call time, so they reflect admin edits made after boot.
- e9aad03: Plugin SDK: `registerRoutes(scope, ctx)` now mounts plugin-contributed HTTP
  routes on Hono at `/api/v2/plugins/<name>/<path>`. The previous no-op stub is
  replaced by a real surface: `scope.route(method, path, handler, opts?)` takes a
  plain Hono `Context` handler, with a `public` flag (bypass Crowi auth for
  self-authenticating webhooks) and a guaranteed raw-body access (no body-consuming
  validator runs ahead of the handler, so `c.req.text()` / `c.req.raw` yield the
  exact bytes the client sent) for HMAC signature verification. The `<name>` path
  segment isolates each plugin from core endpoints and from other plugins.

## 0.1.0-alpha.1

### Patch Changes

- ff63cd1: Declare an explicit `zod` peer dependency range (`^4`) instead of `catalog:`. pnpm does not resolve the `catalog:` protocol inside `peerDependencies` during a workspace/source install, so building Crowi from source emitted a spurious `unmet peer zod@catalog:` warning for every plugin. Published packages were already correct (pnpm rewrites `catalog:` to a concrete range on publish), so npm consumers were unaffected — this only silences the noisy source/Docker-build install. Declaring `^4` also more honestly states that the plugins are compatible with any zod 4.x the host application provides.

## 0.1.0-alpha.0

### Minor Changes

- a52d03f: Initial publish preparation: monorepo restructure complete (RFC-0002 →
  feature-monorepo-packages-restructure). All packages now use
  workspace: protocol internally, peerDependencies for plugin boundaries,
  shared @crowi/tsconfig presets, and a publish-ready layout under
  packages/\*.
- 966d133: Make email delivery plugin-based.

  Email sending is now a pluggable transport. The core assembles every
  message (from / subject / rendered body) so it is identical regardless of
  which sender is active, and a mail sender plugin only delivers the
  finished message. The active sender is selected by
  `crowi.config.json:mail.driver` (default `smtp`), mirroring the storage
  and search single-active-driver model.

  - New `@crowi/plugin-mail-smtp` (default-on) delivers over SMTP via
    nodemailer.
  - New `@crowi/plugin-mail-resend` and `@crowi/plugin-mail-aws-ses`
    (depends on `@crowi/plugin-aws`) official senders.
  - New `registerMailSender` plugin hook + `MailSender` / `EmailMessage`
    contract in `@crowi/plugin-api`.
  - `/admin/mail` now owns only the sender-independent `from` address, shows
    the active sender, and sends a test mail through it; each sender's
    credentials are configured under `/admin/plugins`.

  BREAKING: the legacy `mail:smtp*` / `mail:aws:*` Config keys and the SMTP
  / SES fields of the `admin.mail` API are removed. SMTP credentials live in
  the `@crowi/plugin-mail-smtp` plugin config namespace instead.

- 7f77407: Plugins can now localize their admin config-form field labels and descriptions.
  A plugin declares a `configI18n` catalog (`locale → field → { label, description }`)
  and the admin API overlays the entry matching the requesting admin's locale on
  top of the schema-derived field; the Zod `.describe()` text remains the default
  when a translation is missing. The `GET /admin/plugins/config` endpoint accepts
  an optional `locale` query parameter, and `PluginField` gained an optional
  `label`. The PlantUML renderer ships Japanese translations for its server URL
  and image format fields as the first consumer.
