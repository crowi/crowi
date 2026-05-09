import type { z } from 'zod';
import type { PluginContext } from './context';
import type { StorageRegistry } from './registries/storage';
import type { SearchRegistry } from './registries/search';
import type { AuthRegistry } from './registries/auth';
import type { NotifierRegistry } from './registries/notifier';
import type { EventBus } from './events';
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
    section?: 'settings' | 'shared' | 'storage' | 'mail' | 'notification' | 'auth';
    label?: string;
    icon?: string;
  };

  /** Storage driver registration. Called once at boot. */
  registerStorage?: (registry: StorageRegistry, ctx: PluginContext) => void;

  /** Search backend registration. Called once at boot. */
  registerSearch?: (registry: SearchRegistry, ctx: PluginContext) => void;

  /** Auth provider registration. Called once at boot. */
  registerAuth?: (registry: AuthRegistry, ctx: PluginContext) => void;

  /** Notification sink registration. Called once at boot. */
  registerNotifier?: (registry: NotifierRegistry, ctx: PluginContext) => void;

  /**
   * Event subscription registration. Reserved for v2.0 internal use;
   * not yet a stable extension point for community plugins.
   */
  registerHooks?: (events: EventBus, ctx: PluginContext) => void;

  /**
   * ts-rest contract that the plugin contributes. Mounted at
   * `/api/v2/plugins/<name>/*` (the `<name>` path segment guarantees
   * that core endpoints and other plugins cannot collide). Used for
   * "Test connection" buttons, OAuth callbacks, custom admin views,
   * etc. The contract surface uses ts-rest so the admin UI can call
   * plugin endpoints with the same `apiClient.<plugin>.<method>` shape
   * it uses for core endpoints.
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
