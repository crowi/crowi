# RFC-0001: Plugin Architecture

- **Status**: Draft
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
│  plugins: ["@crowi/storage-aws-s3", ...]           │
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

  /** Other plugins this plugin needs at runtime. e.g. ['@crowi/aws']. */
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
   * Lifecycle event subscriptions (page saved, comment added, etc.).
   * Reserved for v2.0 internal use; not yet a stable extension point for
   * community plugins.
   */
  registerHooks?: (events: EventBus, ctx: PluginContext) => void;

  /**
   * Custom REST endpoints mounted at `/api/v2/plugins/<name>/*`.
   * Used for "Test connection" buttons, OAuth callbacks, etc.
   */
  registerRoutes?: (router: PluginRouter, ctx: PluginContext) => void;

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
   *implicit defaults* (`@crowi/storage-local`, `@crowi/search-mongo`,
   `@crowi/auth-local`) so a fresh install starts with a working Wiki.
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
`storage.driver = 's3'` but `@crowi/storage-aws-s3` isn't installed), boot
fails with a clear error pointing at the missing plugin.

## Distribution & CLI

### Packages

| Package | Contents |
|---|---|
| `@crowi/plugin-api` | Type-only contract: `CrowiPlugin`, registries, context |
| `@crowi/server` | The runtime: Express + ts-rest API + bundled Next.js production build + PluginManager |
| `@crowi/cli` | `crowi init`, `crowi plugin add/remove`, `crowi start`, `crowi migrate` |
| `@crowi/storage-local` | Default storage driver — bundled and auto-loaded |
| `@crowi/storage-aws-s3` | S3 driver |
| `@crowi/search-mongo` | Default search driver (Mongo regex) — bundled and auto-loaded |
| `@crowi/search-elasticsearch` | ES driver |
| `@crowi/auth-local` | Default password auth — bundled and auto-loaded |
| `@crowi/auth-google` | Google OAuth |
| `@crowi/auth-github` | GitHub OAuth |
| `@crowi/notify-slack` | Slack notification sink |

### `crowi.config.json`

```jsonc
{
  "$schema": "https://crowi.io/schema/2.0/config.json",
  "plugins": [
    "@crowi/storage-aws-s3",
    "@crowi/search-elasticsearch",
    "@crowi/auth-google"
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
crowi init <dir>              # scaffold project: data/, crowi.config.json, .env
crowi plugin add <pkg>...     # npm install + append to plugins[]
crowi plugin remove <pkg>     # npm uninstall + drop from plugins[]
crowi plugin list             # show installed plugins + versions + status
crowi start                   # launch the server (production)
crowi migrate                 # run any pending data migrations
```

`crowi plugin add` validates the name against the `@crowi/*` allowlist for
v2.0. The allowlist constraint is removed in a future RFC once we have a
trust story for community plugins.

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
- New config keys (under `@crowi/storage-aws-s3`): same field names,
  prefixed `plugin:storage-aws-s3:*`.
- `onInstall` runs once on first activation: copy `upload:aws:*` →
  `plugin:storage-aws-s3:*`. Files in the bucket are not touched.
- Object key naming preserved verbatim (e.g. `attachment/<pageId>/<filename>`).

### Storage (local)

- Legacy: files at `data/uploads/<id>/...`.
- New: `@crowi/storage-local` reads/writes the same path. No migration
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
  - `@crowi/storage-local`, `@crowi/storage-aws-s3`
  - `@crowi/search-mongo`, `@crowi/search-elasticsearch`
  - `@crowi/auth-local`, `@crowi/auth-google`, `@crowi/auth-github`
  - `@crowi/notify-slack`
- Schema-driven admin form
- v1.x → v2.0 config migration for the legacy keys above

Out of scope (deferred to v2.1 RFCs):

- Renderer / Markdown extension plugins
- Lifecycle event hooks as a public extension point
- Community plugin registry / signed plugins / sandboxing
- GCP Storage / Azure Blob storage drivers
- Algolia / Meilisearch search drivers
- SAML / OIDC / LDAP auth plugins
- Discord / Webhook / Email notifier plugins
- Hot-reload of plugins (always requires restart in v2.0)

## Open questions

1. **Mongo regex search as the default**: is `$regex` against `path` /
   `title` / `body` good enough as a no-op fallback when the ES plugin
   isn't installed? Or should we ship a tiny in-process inverted-index
   driver as `@crowi/search-mongo`?
2. **Plugin-provided routes vs. ts-rest contract**: should `registerRoutes`
   take an Express router, or register a ts-rest contract? The latter is
   typed but forces every plugin to depend on ts-rest.
3. **Auth-local in core or as a plugin?** It's listed as a plugin
   (`@crowi/auth-local`) above, but local password auth is so foundational
   that bundling it directly in core may be cleaner. The cost: harder to
   later disable for a passwordless installation.
4. **Plugin uninstall data semantics**: when removing
   `@crowi/storage-aws-s3`, do we leave the `plugin:storage-aws-s3:*`
   config rows in place (in case the operator reinstalls), or wipe them?
   Default: leave them; provide `crowi plugin remove --purge` to wipe.
5. **Config secret rotation**: today's sensitive Config encryption is
   centralised in core. When a plugin defines a new sensitive field,
   re-encryption ("admin: re-encrypt all sensitive values") must enumerate
   *all installed plugins'* sensitive keys. Mechanism TBD — likely
   `PluginManager.listSensitiveKeys()` walking each plugin's `configSchema`.
6. **CLI lockfile semantics**: `crowi plugin add` writes to `package.json`
   + `package-lock.json` of the project's `node_modules/`. Do we expose
   the project root as a regular npm project (so `npm install` after
   `git pull` works), or wrap it behind the CLI? Leaning toward exposing
   it.
7. **Plugin UI customisation beyond config form**: Slack notification
   "Add channel mapping" is a list-management UI, not a single form.
   Likely needs a richer admin section than what schema-driven generation
   covers. Open: do we allow plugins to ship a precompiled Next.js page,
   accept the iframe approach, or define a richer schema vocabulary?

## Implementation plan (informational, not part of the contract)

Order of work for the v2.0 release:

1. Ship `@crowi/plugin-api` types (this RFC's interfaces).
2. Build `PluginManager` in `apps/crowi-api` against the existing monorepo
   layout — no packaging yet, just the loader.
3. Convert storage to a plugin: extract the existing local + S3 uploaders
   into `@crowi/storage-local` + `@crowi/storage-aws-s3`. Validate
   end-to-end that file upload still works.
4. Convert search: extract the ES client into `@crowi/search-elasticsearch`
   + add `@crowi/search-mongo` as the default fallback.
5. Convert auth: extract Google / GitHub passport strategies into
   `@crowi/auth-google` / `@crowi/auth-github`. Local password auth stays
   in core (per open question #3, decide finally here).
6. Convert notification (slack).
7. Schema-driven admin form generalisation.
8. CLI + server runtime packaging — `@crowi/cli`, `@crowi/server`,
   `crowi init` flow.
9. Legacy config migration runner (`crowi migrate`).
10. Documentation: migration guide for v1.x users.

Each numbered step is a multi-PR effort. Steps 3–6 can run in parallel
once step 2 lands.
