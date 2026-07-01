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
   * Zod schema describing this plugin's *global* configurable values.
   * The admin UI generates a config form by walking this schema.
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
   * `/api/v2/plugins/<name>/<path>` (the `<name>` path segment guarantees
   * that core endpoints and other plugins cannot collide). Used for
   * inbound webhooks (Slack events / slash / interactivity), "Test
   * connection" buttons, `@action` targets, OAuth callbacks, etc.
   *
   * Each route is a plain Hono handler — `scope.route(method, path,
   * (c) => Response, opts?)`. The handler receives the raw `Context`, so
   * `c.req.text()` / `c.req.raw` give the exact request bytes (no
   * validator consumes the body ahead of it — the Slack signature check
   * relies on this). Pass `{ public: true }` to bypass `createJwtAuth`
   * for self-authenticating webhooks; omit it for Crowi-session-gated
   * routes.
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
