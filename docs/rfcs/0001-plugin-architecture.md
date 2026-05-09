# RFC-0001: Plugin Architecture

- **Status**: Draft (round 2 — open-question resolutions integrated)
- **Target**: Crowi 2.0 release
- **Owner**: TBD
- **Last updated**: 2026-05-08

## Summary

Make Crowi extensible by moving four orthogonal concerns — file **storage**,
external **search**, external **auth providers**, and external **notification
sinks** — out of the core into independently distributable plugins. The core
ships with sensible defaults that work without any plugin installed. Operators
add plugins by `crowi plugin add @crowi/<name>` and configure them from the
admin UI.

## Goals

- **Pluggable backends** for storage, search, auth, and notification, so an
  operator can swap one (or more) without rebuilding the application.
- **Default-on, batteries-included core**: a fresh install with zero plugins
  must still be a working Wiki — local file storage, Mongo regex search,
  email + password auth, in-app notifications.
- **npm-distributed plugins**, installed by a small CLI into a project-local
  `node_modules/`. No global plugin registry / no curl-piped installer.
- **Backward compatible with v1.x data**: existing uploaded files, ES indices,
  Slack webhooks, and OAuth client credentials continue to work after
  upgrading and installing the matching plugins. The *configuration storage*
  changes (config keys move into a plugin namespace) but the *data layout*
  does not.
- **Stable plugin API across the v2.x line**. Plugins authored against
  `@crowi/plugin-api@2.x` keep working through every v2 minor.

## Non-goals (this RFC)

- Renderer / Markdown / front-end plugins. Out of scope for v2.0; revisited
  in a follow-up RFC.
- Community-contributed plugins. v2.0 only allows installing official
  `@crowi/*` plugins via the CLI; community plugins are opt-in and gated on a
  later "trust" decision.
- Hot-reload / install-without-restart. Plugin install requires a server
  restart, like every other Node app.
- Sandboxed plugin execution. Plugins run with the same Node permissions as
  the server. We rely on npm publisher trust + the official-only restriction.

## Overview

```
┌──────────────────── @crowi/cli ────────────────────┐
│  crowi init / plugin add / start / migrate         │
└──────────┬─────────────────────────────────────────┘
           │ writes to / reads from
           ▼
┌─────────────────── crowi.config.json ──────────────┐
│  plugins: ["@crowi/plugin-storage-aws-s3", ...]           │
└──────────┬─────────────────────────────────────────┘
           │ at boot
           ▼
┌─────────────── @crowi/server (runtime) ────────────┐
│  ┌─── PluginManager ────────────────────────────┐  │
│  │   loads plugins listed in config             │  │
│  │   resolves `requires`                        │  │
│  │   runs each plugin's register*() hooks       │  │
│  │                                              │  │
│  │   Registries:                                │  │
│  │     StorageRegistry ──────► driver: 'local'  │  │
│  │     SearchRegistry  ──────► driver: 'mongo'  │  │
│  │     AuthRegistry    ──────► local-password   │  │
│  │     NotifierRegistry ─────► (none, in-app)   │  │
│  └──────────────────────────────────────────────┘  │
│                                                    │
│  Express + ts-rest API + bundled Next.js prod      │
└────────────────────────────────────────────────────┘
```

A plugin is an npm package whose default export satisfies the `CrowiPlugin`
interface. At boot the runtime imports each plugin in dependency order, calls
its `register*` callbacks, and exposes the resulting registries to the rest
of the application via `crowi.getStorage()`, `crowi.getSearch()`, etc.

## The `CrowiPlugin` interface

Lives in **`packages/plugin-api/`** and is published as `@crowi/plugin-api`.
This is the only contract plugins depend on; the package contains *only*
type definitions and a few zero-dependency helpers.

```ts
import type { z } from 'zod';

export interface CrowiPlugin {
  /** Stable npm name. Used for dependency resolution and config-key prefix. */
  name: string;

  /** Plugin's own version (matches the npm package's semver). */
  version: string;

  /** Other plugins this plugin needs at runtime. e.g. ['@crowi/plugin-aws']. */
  requires?: string[];

  /**
   * Zod schema describing this plugin's configurable values. The admin UI
   * generates a form from this. Mark sensitive fields with the
   * `@sensitive` description marker (see "Sensitive config" below).
   */
  configSchema?: z.ZodObject<Record<string, z.ZodTypeAny>>;

  /** Storage driver registration. */
  registerStorage?: (registry: StorageRegistry, ctx: PluginContext) => void;

  /** Search backend registration. */
  registerSearch?: (registry: SearchRegistry, ctx: PluginContext) => void;

  /** Auth provider registration (passport-style strategy). */
  registerAuth?: (registry: AuthRegistry, ctx: PluginContext) => void;

  /** Notification sink registration. */
  registerNotifier?: (registry: NotifierRegistry, ctx: PluginContext) => void;

  /**
   * Per-Page metadata schema. Each plugin gets a private namespace at
   * `page.metadata['<plugin-name>']`. Lets a plugin attach config to an
   * individual page (e.g. Slack's per-page channel mapping) without
   * polluting the core Page schema.
   *
   * The page-edit UI walks installed plugins and renders one section
   * per plugin that contributes a `pageMetadataSchema`, via the same
   * schema-driven form used for global config.
   */
  pageMetadataSchema?: z.ZodObject<Record<string, z.ZodTypeAny>>;

  /**
   * Lifecycle event subscriptions (page saved, comment added, etc.).
   * Reserved for v2.0 internal use; not yet a stable extension point for
   * community plugins.
   */
  registerHooks?: (events: EventBus, ctx: PluginContext) => void;

  /**
   * ts-rest contract that the plugin contributes. Mounted at
   * `/api/v2/plugins/<name>/*` (the `<name>` segment guarantees no
   * collision with core endpoints). Used for "Test connection" buttons,
   * OAuth callbacks, etc.
   *
   * The contract surface uses ts-rest so the admin UI can call into
   * plugin endpoints with the same `apiClient.<plugin>.<method>` shape
   * it uses for core endpoints. Plugins depend on the same `@ts-rest/core`
   * version as core via a peer dependency.
   */
  registerRoutes?: (s: PluginRouterScope, ctx: PluginContext) => void;

  /**
   * Run-once setup when this plugin is first activated. Typically used
   * for legacy config migration (see "Backwards compatibility").
   */
  onInstall?: (ctx: PluginContext) => Promise<void>;

  /** Symmetric to `onInstall`; called when the plugin is removed. */
  onUninstall?: (ctx: PluginContext) => Promise<void>;
}
```

### `PluginContext`

What plugins receive when their callbacks run:

```ts
export interface PluginContext {
  /** Read this plugin's typed config (from configSchema). */
  config: <S extends z.ZodTypeAny>() => z.infer<S>;
  /** Write a value to this plugin's config namespace. */
  setConfig: (key: string, value: unknown) => Promise<void>;
  /** Read/write the plugin's per-Page metadata namespace. */
  pageMetadata: {
    get: <T>(pageId: string) => Promise<T | null>;
    set: <T>(pageId: string, value: T) => Promise<void>;
  };
  /** Mongoose models exposed by core (Page, User, Config, ...). */
  model: <K extends keyof CoreModels>(name: K) => CoreModels[K];
  /** Encrypt / decrypt — same KeyProvider as core sensitive Config. */
  crypto: { encrypt: (s: string) => string; decrypt: (s: string) => string };
  /** Structured logger scoped to the plugin. */
  log: { info: (...) => void; warn: (...) => void; error: (...) => void };
}
```

### Registry interfaces

```ts
export interface StorageDriver {
  put(key: string, body: Buffer | NodeJS.ReadableStream, meta: { contentType: string }): Promise<{ key: string }>;
  get(key: string): Promise<NodeJS.ReadableStream>;
  delete(key: string): Promise<void>;
  signedUrl?(key: string, expiresInSec: number): Promise<string>;
}

export interface StorageRegistry {
  register(driverName: string, driver: StorageDriver): void;
}

export interface SearchDriver {
  index(doc: SearchableDoc): Promise<void>;
  remove(id: string): Promise<void>;
  query(q: SearchQuery): Promise<SearchHits>;
  rebuild?(): Promise<void>;
}

// (similar for AuthRegistry, NotifierRegistry)
```

The exact shapes are still in flux — they should be the *minimum* surface
each driver needs and grow only on demand. v2.0 release locks them.

### Sensitive config

Fields whose Zod description starts with `@sensitive` (e.g.
`z.string().describe('@sensitive AWS secret access key')`) are encrypted by
core at write time and decrypted on read, reusing the existing
`util/crypto.ts` + `models/config-sensitive.ts` machinery.

## Plugin loading & dependency resolution

At boot, after `setupConfig` and before `setupSearcher` / `setupMailer` /
etc., the runtime runs `PluginManager.loadAll()`:

1. Read `plugins: string[]` from `crowi.config.json`. Always prepend the
   *implicit defaults* (`@crowi/plugin-storage-local`, `@crowi/plugin-search-mongo`) so
   a fresh install starts with a working Wiki. Local password auth lives
   in core itself, not in a plugin, so it doesn't appear here.
2. For each name, `await import(name)` to load the module. The package's
   default export must satisfy `CrowiPlugin` — fail boot loudly otherwise.
3. Build a dependency graph from each plugin's `requires` array; topologically
   sort. Cycles are an error.
4. For each plugin in topo order:
   - If this is the first time we've seen it, await `onInstall(ctx)`.
   - Call any `register*` callbacks the plugin provides; pass each callback a
     registry that's scoped to *this plugin only* (so we can attribute "who
     registered driver `s3`?").
5. After all plugins are loaded, the registries are frozen. The default
   driver for each registry is read from a top-level config setting:
   `storage.driver = 's3' | 'local' | …`.

If a configured driver name is not present in the registry (e.g. config says
`storage.driver = 's3'` but `@crowi/plugin-storage-aws-s3` isn't installed), boot
fails with a clear error pointing at the missing plugin.

## Distribution & CLI

### Packages

| Package | Contents |
|---|---|
| `@crowi/plugin-api` | Type-only contract: `CrowiPlugin`, registries, context |
| `@crowi/server` | The runtime: Express + ts-rest API + bundled Next.js production build + PluginManager |
| `@crowi/cli` | `crowi init`, `crowi plugin add/remove`, `crowi start`, `crowi migrate` |
| `@crowi/plugin-storage-local` | Default storage driver — bundled and auto-loaded |
| `@crowi/plugin-storage-aws-s3` | S3 driver |
| `@crowi/plugin-search-mongo` | Default search driver (Mongo `$regex` over path / title / body) — bundled and auto-loaded |
| `@crowi/plugin-search-elasticsearch` | ES driver |
| `@crowi/plugin-auth-google` | Google OAuth |
| `@crowi/plugin-auth-github` | GitHub OAuth |
| `@crowi/plugin-notify-slack` | Slack notification sink |

Local password / session / JWT auth lives in **core**, not as a plugin.
Foundational enough that every install needs it and decoupling adds more
complexity than value.

### `crowi.config.json`

```jsonc
{
  "$schema": "https://crowi.io/schema/2.0/config.json",
  "plugins": [
    "@crowi/plugin-storage-aws-s3",
    "@crowi/plugin-search-elasticsearch",
    "@crowi/plugin-auth-google"
  ],
  "storage": { "driver": "s3" },
  "search":  { "driver": "elasticsearch" }
}
```

Plugin-specific config (S3 bucket, ES URL, Google client_id, …) is **not**
in this file — it lives in the existing Mongo `Config` collection under
`plugin:<name>:<key>` keys, set via the admin UI.

### CLI commands

```
crowi init <dir>              # scaffold project: data/, crowi.config.json, .env, package.json
crowi plugin add <pkg>...     # npm install + append to plugins[]
crowi plugin remove <pkg>     # npm uninstall + drop from plugins[] (config rows kept by default)
crowi plugin remove <pkg> --purge
                              # …also delete plugin:<name>:* config rows from Mongo
crowi plugin list             # show installed plugins + versions + status
crowi start                   # launch the server (production)
crowi migrate                 # run any pending data migrations
```

`crowi plugin add` validates the name against the `@crowi/*` allowlist for
v2.0. The allowlist constraint is removed in a future RFC once we have a
trust story for community plugins.

The `--purge` flag on remove exists because, by default, removing a plugin
keeps its config rows in place — the operator may reinstall the plugin
later (e.g. while reorganising) and would lose AWS keys / OAuth client
secrets if removal also wiped them. `--purge` is the explicit "I know what
I'm doing, drop the rows too" gesture.

### Project layout

`crowi init` produces a regular npm project — `package.json`,
`node_modules/`, lockfile and all — so power users can run `npm install`
directly, edit `package.json`, or pin plugin versions with their normal
tooling. The CLI is a convenience wrapper on top, not a replacement.

```
my-wiki/
├── package.json           ← regular npm project; CLI writes to it
├── package-lock.json
├── node_modules/          ← @crowi/server + @crowi/cli + plugins live here
├── crowi.config.json      ← CLI's source of truth for installed plugin list
├── .env                   ← CROWI_ENCRYPTION_KEY, MONGO_URI, etc.
└── data/                  ← local file uploads (when @crowi/plugin-storage-local is active)
```

CI deploy story: commit `crowi.config.json` + `package.json` +
`package-lock.json`; CI runs `npm ci && crowi migrate && crowi start`. No
git clone of the Crowi repo required.

### Docker distribution

Two image variants published to Docker Hub:

- **`crowi/server:2.0`** — `@crowi/cli` + `@crowi/server` + the four
  default-on / bundled plugins. Sufficient for a fresh install with local
  storage / Mongo regex search / local password auth.
- **`crowi/server-full:2.0`** — same plus all official `@crowi/*` plugins
  preinstalled (S3 / ES / Google OAuth / GitHub OAuth / Slack). Operators
  pick the drivers they want via `crowi.config.json`.

Custom-plugin operators extend the base image:

```Dockerfile
FROM crowi/server:2.0
RUN crowi plugin add @crowi/plugin-storage-aws-s3 @crowi/plugin-notify-slack
COPY crowi.config.json /app/
```

Or they mount their `package.json` + `crowi.config.json` and let the
container `npm ci` at startup. Both work because the project layout above
is a regular npm project.

## Admin UI

Each plugin's admin section is generated by a **schema-driven form**. The
form takes the plugin's `configSchema`, walks it, and renders one field per
property using a fixed mapping:

| Zod type | UI control |
|---|---|
| `z.string()` | `<Input>` |
| `z.string().describe('@sensitive ...')` | `<SecretField>` |
| `z.number()` | `<Input type=number>` |
| `z.boolean()` | `<Switch>` |
| `z.enum([...])` | `<Select>` |
| `z.array(z.string())` | `<Textarea>` (newline-separated) |

For dynamic actions a generic form can't express ("Test connection",
"Authorize with Google"), the plugin registers a REST endpoint via
`registerRoutes` and the schema field is annotated with
`.describe('@action button-label POST /test')`. The admin UI renders an
extra button next to the field that calls the endpoint.

OAuth callback URLs are reserved by core: `GET /api/v2/plugins/<name>/oauth/callback`
is mounted unconditionally for every auth plugin and forwarded into its
`registerRoutes` handler.

## Backwards compatibility

For each existing v1.x feature being plugin-ified, the migration story:

### Storage (S3)

- Legacy config keys: `upload:aws:region`, `upload:aws:bucket`,
  `upload:aws:accessKeyId`, `upload:aws:secretAccessKey`.
- New config keys (under `@crowi/plugin-storage-aws-s3`): same field names,
  prefixed `plugin:storage-aws-s3:*`.
- `onInstall` runs once on first activation: copy `upload:aws:*` →
  `plugin:storage-aws-s3:*`. Files in the bucket are not touched.
- Object key naming preserved verbatim (e.g. `attachment/<pageId>/<filename>`).

### Storage (local)

- Legacy: files at `data/uploads/<id>/...`.
- New: `@crowi/plugin-storage-local` reads/writes the same path. No migration
  needed beyond marking the plugin as the active driver (which is the
  default anyway).

### Search (Elasticsearch)

- Legacy config keys: `ELASTICSEARCH_URI` (env), index name hard-coded.
- New: `plugin:search-elasticsearch:url` (or env override), index name
  configurable but defaults to legacy value.
- ES indices are reused — no re-index required.

### Auth (Google / GitHub)

- Legacy: passport strategies wired in `lib/passport*.ts`, client_id /
  secret in `Config` (`security:google:clientId` etc.) — already
  migration-completed under sensitive Config encryption.
- New: `plugin:auth-google:clientId` / `secret`, copied on `onInstall`.
- Sessions / JWT cookies stay valid across the migration.

### Notification (Slack)

- Legacy: webhook URL + token in `Config` (`slack:incomingWebhookUrl`,
  `slack:token`).
- New: `plugin:notify-slack:webhookUrl` / `token`, copied on `onInstall`.
- Channel mapping table (`slack-app-integration` collection) is unchanged.

### Configuration storage shape

The Mongo `Config` collection schema does not change. Plugin keys are just
new namespaces alongside the existing `crowi:*`, `security:*`, etc. The
`isSensitiveConfig` test is augmented to recognise plugin-marked fields
via `configSchema` introspection.

## v2.0 release scope

In scope:

- `@crowi/plugin-api` — the contract
- `@crowi/server` runtime + PluginManager
- `@crowi/cli` (`init`, `plugin add/remove/list`, `start`, `migrate`)
- Plugins:
  - `@crowi/plugin-storage-local`, `@crowi/plugin-storage-aws-s3`
  - `@crowi/plugin-search-mongo`, `@crowi/plugin-search-elasticsearch`
  - `@crowi/plugin-auth-google`, `@crowi/plugin-auth-github`
  - `@crowi/plugin-notify-slack`
- Local password / session / JWT auth stays in **core** (not a plugin)
- Schema-driven admin form
- v1.x → v2.0 config migration for the legacy keys above
- Docker images: `crowi/server:2.0` (default-on plugins) and
  `crowi/server-full:2.0` (all official plugins preinstalled)

Out of scope (deferred to v2.1 RFCs):

- Renderer / Markdown extension plugins
- Lifecycle event hooks as a public extension point
- Community plugin registry / signed plugins / sandboxing
- GCP Storage / Azure Blob storage drivers
- Algolia / Meilisearch search drivers
- SAML / OIDC / LDAP auth plugins
- Discord / Webhook / Email notifier plugins
- Hot-reload of plugins (always requires restart in v2.0)

## Resolved decisions (round 2 review)

1. **Search default fallback** → `@crowi/plugin-search-mongo` is a thin wrapper
   over Mongo `$regex` against `path` / `title` / `body`. No inverted
   index in core; if you need real search, install `@crowi/plugin-search-elasticsearch`.
2. **Plugin routes** → ts-rest contracts, mounted under
   `/api/v2/plugins/<name>/*`. The `<name>` path prefix is the namespace
   guarantee — plugins cannot collide with core endpoints or each other.
3. **`auth-local`** → stays in core. Not packaged as a plugin.
4. **Uninstall data** → keep config rows by default, `--purge` flag wipes.
   Files / indices / external state owned by the plugin (S3 objects, ES
   indices) are *never* touched by uninstall — operators clean those up
   on their own infrastructure.
5. **Sensitive key enumeration across plugins** → `PluginManager.listSensitiveKeys()`
   walks each loaded plugin's `configSchema` and returns the union of all
   `@sensitive`-marked field paths. Core's "re-encrypt all" routine
   consults this list instead of the legacy hardcoded
   `models/config-sensitive.ts`. The legacy list stays as a compat
   bridge for the v1.x → v2.0 transition; plugins eventually own it.
6. **Project layout** → regular npm project (visible `package.json`
   etc., see "Project layout" above). The CLI is a convenience layer on
   top, not a replacement. Docker-based deployment is supported by
   shipping `crowi/server:2.0` images, see "Docker distribution".

## Open questions

1. **Plugin-contributed page-scoped metadata** (raised by Slack channel
   mapping): the legacy "channel mapping" admin table — global
   `path-glob → slack channel` rules — is widely considered awkward.
   A cleaner model is per-Page metadata namespaced by plugin:

   ```ts
   // on the Page document
   metadata: {
     'notify-slack': { channel: '#eng-team' },
     // other plugins' fields, keyed by plugin name
   }
   ```

   Plugins read/write through `ctx.pageMetadata(page._id, '<plugin-name>')`.
   The page-edit UI surfaces a "Plugin settings" panel that walks installed
   plugins and renders any per-page schema each contributes
   (`pageMetadataSchema?: z.ZodObject<...>`).

   Open sub-questions:
   - **Inheritance / glob fallback**: the legacy table allowed
     `'/eng/*' → '#eng'` so every new page under `/eng/` got the channel
     for free. Per-page metadata loses this. Two paths:
     (a) plugin also supports an admin-side "path rules" table that fills
     `page.metadata` on save, or
     (b) drop the inheritance feature entirely and require explicit
     per-page metadata.
   - **Where the panel lives**: page edit screen, page settings dialog,
     or a separate `/<path>/metadata` admin route?
   - **Permission model**: who can edit plugin metadata on a page —
     anyone with edit rights to the page, or admins only?

   Defer the full design to a follow-up RFC scoped to the Slack plugin
   redesign; this RFC just commits to providing the `pageMetadata` /
   `pageMetadataSchema` extension points so the eventual plugin can use
   them.

2. **Bundled core defaults**: `@crowi/plugin-storage-local` and
   `@crowi/plugin-search-mongo` are listed as separate npm packages bundled
   with `@crowi/server`. Alternatively they could be inline modules in
   core. The npm-package version is more consistent with the plugin
   model but adds packaging overhead. Decide during step 1 of the
   implementation plan.

3. **Plugin API versioning**: `@crowi/plugin-api@2.x` is the contract for
   all v2.x plugins. When v3 introduces breaking changes, plugins remain
   on v2 until they migrate. Concretely: should `@crowi/server` accept
   plugins that depend on multiple major versions of `plugin-api`, or
   reject mismatches at boot? Lean reject — too easy to silently break.

## Implementation plan (informational, not part of the contract)

Order of work for the v2.0 release:

1. Ship `@crowi/plugin-api` types (this RFC's interfaces).
2. Build `PluginManager` in `apps/crowi-api` against the existing monorepo
   layout — no packaging yet, just the loader.
3. Convert storage to a plugin: extract the existing local + S3 uploaders
   into `@crowi/plugin-storage-local` + `@crowi/plugin-storage-aws-s3`. Validate
   end-to-end that file upload still works.
4. Convert search: extract the ES client into `@crowi/plugin-search-elasticsearch`
   + add `@crowi/plugin-search-mongo` as the default fallback.
5. Convert auth: extract Google / GitHub passport strategies into
   `@crowi/plugin-auth-google` / `@crowi/plugin-auth-github`. Local password auth stays
   in core; the AuthRegistry is a list of *additional* providers that the
   login screen surfaces alongside the always-on email-and-password form.
6. Convert notification (slack).
7. Schema-driven admin form generalisation.
8. CLI + server runtime packaging — `@crowi/cli`, `@crowi/server`,
   `crowi init` flow.
9. Legacy config migration runner (`crowi migrate`).
10. Documentation: migration guide for v1.x users.

Each numbered step is a multi-PR effort. Steps 3–6 can run in parallel
once step 2 lands.
