import type { z } from 'zod/v3';
import type { PluginContext } from './context';
import type { StorageRegistry } from './registries/storage';
import type { SearchRegistry } from './registries/search';
import type { AuthRegistry } from './registries/auth';
import type { NotifierRegistry } from './registries/notifier';
import type { MailSenderRegistry } from './registries/mail';
import type { EventBus } from './events';
import type { RendererRegistry } from './renderer';
import type { PluginRouterScope } from './routes';

/**
 * Declares that, when a specific driver from a specific registry is
 * selected (`crowi.config.json:<registry>.driver === driver`), this
 * plugin's own config becomes required to actually work at runtime —
 * even though the `configSchema` field itself is optional / defaults to
 * `''` so `configSchema.parse()` alone can't detect "present but
 * unusable" (see `@crowi/plugin-storage-aws-s3`'s `bucket` and
 * `@crowi/plugin-search-elasticsearch` / `@crowi/plugin-search-opensearch`'s
 * `url`, both `z.string().default('')`).
 *
 * This is metadata only — it never carries an actual config value.
 * `registry` / `driver` / every name in `requiredConfigFields` must be
 * non-empty. The runtime (`PluginManager.getReadinessIssues()`) reads
 * this once per admin readiness check, cross-references it against the
 * currently selected driver and the plugin's current config namespace,
 * and reports which declared fields are still empty — never the values
 * themselves. See RFC-none / feature-plugin-config-readiness.
 */
export interface PluginReadinessDeclaration {
  /** Which driver registry this declaration is scoped to. */
  registry: 'storage' | 'search' | 'mail';
  /** The driver name (as registered via `registry.register(name, …)`) this declaration applies to. */
  driver: string;
  /** `configSchema` field names that must be non-empty for `driver` to actually work once selected. */
  requiredConfigFields: string[];
}

/**
 * One all-or-nothing group of `configSchema` fields — see
 * `CrowiPlugin.configAtomicGroups`.
 */
export interface PluginConfigAtomicGroup {
  /**
   * Stable identifier, part of the physical storage key
   * (`plugin:<plugin>:__atomic:<name>`). Renaming it orphans the stored
   * document, so treat it like a migration.
   */
  name: string;
  /** The `configSchema` field names stored together. Non-empty, no duplicates, and each field may belong to only one group. */
  keys: readonly string[];
  /**
   * Encrypt the whole stored group at rest. Set this when ANY member is
   * secret: the group is one value, so it is either all encrypted or all
   * not — there is no per-field choice left once they share a document.
   */
  sensitive?: boolean;
}

/**
 * The contract every Crowi plugin satisfies. Plugins export their
 * `CrowiPlugin` object as the package's default export; the runtime
 * imports it via `await import('<plugin-name>')` at boot.
 *
 * Every `register*` callback is optional — implement only the
 * extension points your plugin actually contributes to. A storage-only
 * plugin needs only `registerStorage`; an auth provider that also
 * exposes admin "Test connection" needs `registerAuth` plus
 * `registerRoutes`.
 */
export interface CrowiPlugin {
  /**
   * Stable npm package name. Doubles as the namespace prefix for this
   * plugin's config rows (`plugin:<name>:*`) and per-Page metadata
   * (`page.metadata['<name>']`). Must match the `name` field in the
   * package's `package.json`.
   */
  name: string;

  /**
   * The plugin's own version (matches the npm package's semver).
   * Surfaced in `crowi plugin list` and emitted in boot logs.
   */
  version: string;

  /**
   * Other plugins this plugin needs at runtime, by npm name (e.g.
   * `['@crowi/plugin-aws']`). The PluginManager resolves the dependency graph
   * at boot and loads `requires` first; cycles fail boot.
   */
  requires?: string[];

  /**
   * Core Mongoose model names (e.g. `['Page', 'Bookmark']`) this plugin
   * is allowed to reach via `ctx.model(name)`. The PluginManager
   * validates every entry against the set of registered core model
   * names at boot — an unknown name fails boot with a descriptive
   * error. `ctx.model(name)` throws at call time for any `name` not
   * listed here.
   *
   * A model listed here is granted full (unrestricted) read/write
   * access — there is no read-only mode. Omit or leave empty for a
   * plugin that never calls `ctx.model()`.
   *
   * Credential-bearing core models (`Config`, `PersonalAccessToken`,
   * OAuth client/token/grant models, `Share`, `ShareAccess`) can never
   * be listed here — declaring one fails boot, and `ctx.model()` also
   * refuses to return one at call time as defense-in-depth. There is no
   * legitimate plugin use case for touching those collections directly.
   */
  modelAccess?: string[];

  /**
   * Opt in to letting *other* plugins read this plugin's config through
   * their `ctx.dependencyConfig<T>(this.name)` (they must also list this
   * plugin in their own `requires`). Defaults to `false` — a plugin's
   * config, including `@sensitive` fields, is private to itself unless
   * it explicitly declares this flag.
   *
   * Set this on a plugin that exists specifically to hold credentials
   * shared by other plugins — e.g. `@crowi/plugin-aws` sets it so
   * `@crowi/plugin-storage-aws-s3` and `@crowi/plugin-mail-aws-ses` can
   * read its `region` / `accessKeyId` / `secretAccessKey` without
   * duplicating them in their own `configSchema`. Most plugins should
   * leave this unset.
   */
  exposesConfigToDependents?: boolean;

  /**
   * Zod schema describing this plugin's *global* configurable values.
   * The admin UI generates a config form by walking this schema.
   *
   * Build this with `import { z } from 'zod/v3'` — NOT the top-level
   * `import { z } from 'zod'` (v4). `peerDependencies: { zod: "^4" }`
   * only says which npm package to install; the v4 package ships a
   * `zod/v3` compat subpath, and that subpath's runtime shape is what
   * every introspection helper here (`schema-serializer.ts`,
   * `schema-markers.ts`, `PluginManager.listSensitiveKeys()`) actually
   * walks. A schema built from the top-level v4 API fails boot with an
   * explicit error (`PluginManager.activate()`'s config-schema guard —
   * see this package's README) rather than silently losing
   * `@sensitive` detection.
   *
   * Mark sensitive fields with the `@sensitive` description marker
   * (see `SENSITIVE_FIELD_MARKER`); they are encrypted at rest via the
   * same KeyProvider used by core's sensitive Config.
   *
   * Mark fields that need a "Test connection" / "Authorise" button
   * with `@action <button-label> <verb> <path>` (see
   * `ACTION_FIELD_MARKER`); the form renders an extra button next to
   * the field that calls the plugin's contributed REST endpoint.
   */
  configSchema?: z.ZodObject<Record<string, z.ZodTypeAny>>;

  /**
   * RFC-0014 phase 4 — `configSchema` fields that must never be visible
   * to anyone in a half-written state, declared as groups that are stored
   * as ONE Config document instead of one row per field.
   *
   * The motivating case is an OAuth client id + secret. Written as
   * separate rows, a failure between them leaves the instance advertising
   * a new client id paired with the previous secret — a configuration
   * that never existed and cannot authenticate, visible to every replica
   * until an operator notices. As a single document there is no
   * in-between: readers see the whole previous pair or the whole new one.
   *
   * This is a STORAGE contract, not a general escape hatch for making
   * arbitrary keys atomic — the fields still appear to the plugin (and to
   * the admin form) as ordinary flat config, and are only reassembled at
   * the persistence boundary.
   */
  configAtomicGroups?: readonly PluginConfigAtomicGroup[];

  /**
   * Per-Page metadata schema. When set, every Page document has a
   * `metadata['<plugin-name>']` slot whose shape matches this schema,
   * and the page-edit UI renders a section for the plugin where the
   * operator can fill in those values per-page.
   *
   * Use case: Slack channel mapping per page (`{ channel: '#eng' }`),
   * custom page metadata for downstream integrations.
   */
  pageMetadataSchema?: z.ZodObject<Record<string, z.ZodTypeAny>>;

  /**
   * How this plugin appears in the admin sidebar. Optional — when
   * omitted, the runtime derives the section from the plugin's
   * `register*` hooks (registerStorage → 'storage', registerAuth →
   * 'auth', etc.). Plugins with no register* hooks (config-only
   * "base plugins" like `@crowi/plugin-aws`) MUST declare `section: 'shared'`
   * to appear in the sidebar at all.
   *
   * `label` overrides the default sidebar text (which would otherwise
   * be the plugin's npm name). `icon` is the lucide-react icon name
   * (e.g. `'cloud'`, `'database'`); admin sidebar only renders icons
   * from a fixed allow-list to keep the bundle small.
   */
  adminPlacement?: {
    section?: 'settings' | 'shared' | 'storage' | 'mail' | 'notification' | 'auth' | 'search' | 'renderer' | 'platform';
    label?: string;
    icon?: string;
  };

  /**
   * Optional localized overrides for the admin config-form field labels and
   * descriptions, keyed by locale then by `configSchema` field name. The
   * admin API overlays the entry matching the requesting admin's locale on
   * top of the schema-derived field; the Zod `.describe()` text stays the
   * (English) default when a locale or field is missing. Lets a plugin ship
   * its own translations without the host app knowing about them.
   *
   * @example
   * configI18n: {
   *   ja: { serverUrl: { description: 'PlantUML サーバーのベース URL。' } },
   * }
   */
  configI18n?: Record<string, Record<string, { label?: string; description?: string }>>;

  /**
   * Declares which of this plugin's own `configSchema` fields must be
   * non-empty for a specific driver selection to actually work at
   * runtime (see {@link PluginReadinessDeclaration}). Optional — a
   * plugin with no readiness declaration is never surfaced by the
   * admin readiness check, same as before this field existed.
   */
  readiness?: PluginReadinessDeclaration;

  /** Storage driver registration. Called once at boot. */
  registerStorage?: (registry: StorageRegistry, ctx: PluginContext) => void;

  /** Search backend registration. Called once at boot. */
  registerSearch?: (registry: SearchRegistry, ctx: PluginContext) => void;

  /** Auth provider registration. Called once at boot. */
  registerAuth?: (registry: AuthRegistry, ctx: PluginContext) => void;

  /** Notification sink registration. Called once at boot. */
  registerNotifier?: (registry: NotifierRegistry, ctx: PluginContext) => void;

  /**
   * Mail sender (transport) registration. Called once at boot. Exactly
   * one registered driver is active, selected by
   * `crowi.config.json:mail.driver` (default `'smtp'`). The core
   * assembles the message; the driver only delivers it.
   */
  registerMailSender?: (registry: MailSenderRegistry, ctx: PluginContext) => void;

  /**
   * Renderer extension registration. Called once at boot, AFTER the
   * core bundled renderer (TOC / wikilinks / mentions / code-block
   * languages) has already populated the registry. Phase 2 honours
   * `addUnifiedPlugin({ phase: 'transform' })` and `addNodeRenderer`;
   * other registrations warn-noop until Phase 3. See RFC-0002.
   */
  registerRenderer?: (registry: RendererRegistry, ctx: PluginContext) => void;

  /**
   * Event subscription registration. Reserved for v2.0 internal use;
   * not yet a stable extension point for community plugins.
   */
  registerHooks?: (events: EventBus, ctx: PluginContext) => void;

  /**
   * HTTP routes the plugin contributes, mounted at
   * `/api/plugins/<name>/<path>` (the `<name>` path segment guarantees
   * that core endpoints and other plugins cannot collide). Used for
   * inbound webhooks (Slack events / slash / interactivity), "Test
   * connection" buttons, `@action` targets, OAuth callbacks, etc.
   *
   * Each route is a plain Hono handler — `scope.route(method, path,
   * (c) => Response, opts?)`. The handler receives the raw `Context`, so
   * `c.req.text()` / `c.req.raw` give the exact request bytes (no
   * validator consumes the body ahead of it — the Slack signature check
   * relies on this). Pass `{ auth: 'public' }` to bypass Crowi auth for
   * self-authenticating webhooks, `{ auth: 'admin' }` for routes that
   * require `user.admin === true`, or omit `opts` for the `'user'`
   * default (any authenticated Crowi user).
   *
   * Called once at boot — but unlike the other `register*` hooks, this
   * runs inside `buildHonoApp` (the Hono app does not exist yet when
   * plugins activate), so a plugin's `registerRoutes` fires slightly
   * later than its `registerStorage` / `registerNotifier` / etc.
   */
  registerRoutes?: (scope: PluginRouterScope, ctx: PluginContext) => void;

  /**
   * Run-once setup when this plugin is first activated. Typically used
   * for legacy v1.x → v2.0 config migration: copy `upload:aws:*` rows
   * into `plugin:<name>:*`, etc. Idempotent — the runtime tracks which
   * plugins have already had `onInstall` invoked and skips on subsequent
   * boots.
   */
  onInstall?: (ctx: PluginContext) => Promise<void>;

  /**
   * Symmetric to `onInstall`; called when the plugin is removed via
   * `crowi plugin remove`. Note: by default config rows are *kept*
   * (the operator may reinstall later) — `onUninstall` runs only when
   * `--purge` is passed.
   */
  onUninstall?: (ctx: PluginContext) => Promise<void>;

  /**
   * Called when this plugin's own config (`plugin:<name>:*`) or any of
   * its `requires` dependency configs change via the admin UI / API.
   * Implementations should refresh any cached state — clients,
   * connection pools, derived values — so subsequent driver method
   * calls see the new values.
   *
   * Optional. If omitted, the plugin is treated as "config changes
   * require a server restart" (back-compat for the existing
   * register-once / closure-captured driver pattern).
   *
   * Best-effort: a thrown error is logged and reported to the admin
   * UI but does NOT crash the server — that would lock operators out
   * of the very UI they need to fix the misconfiguration.
   */
  reconfigure?: (ctx: PluginContext) => void | Promise<void>;
}
