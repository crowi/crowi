import Debug from 'debug';
import { ACTION_FIELD_MARKER, getActionAnnotation } from '@crowi/plugin-api';
import type { AuthDriver, CrowiPlugin, MailSender, NotifierDriver, SearchDriver, StorageDriver } from '@crowi/plugin-api';
import { type CrowiConfigFile, resolvePlugins } from '@crowi/runner';
import type Crowi from 'src/crowi';
import { registerSensitiveConfigKeys } from 'src/models/config-sensitive';
import type { ConfigChangeSource } from 'src/service/config';
import { createPluginContext } from './plugin-context';
import { formatPluginConfigKey, parsePluginNamespace } from './plugin-namespace';
import { makeRendererScope } from 'src/renderer';
import { DriverRegistry, makeAuthScope, makeMailScope, makeNotifierScope, makeSearchScope, makeStorageScope } from './registries';
import { topoSortPlugins } from './topo-sort';

const debug = Debug('crowi:plugin:manager');

/**
 * What `PluginManager.bootstrap()` returns to the surrounding Crowi
 * boot sequence — the resolved registries and active driver
 * resolution. Core services (file uploader, search service, …) read
 * the active drivers from here.
 *
 * `active.storage` and `active.search` are nullable: if no plugin
 * registered the configured driver name, we log a warning and leave
 * the active slot null so legacy in-core code paths keep handling
 * those concerns. This is the v2.0 transition state — once the
 * built-in `@crowi/plugin-storage-local` and `@crowi/plugin-search-mongo` plugins
 * land (Step 3+), the active slots are always populated.
 */
export interface PluginRegistries {
  storage: DriverRegistry<StorageDriver>;
  search: DriverRegistry<SearchDriver>;
  auth: DriverRegistry<AuthDriver>;
  notifier: DriverRegistry<NotifierDriver>;
  mail: DriverRegistry<MailSender>;
  /** Active driver for each registry, resolved from `crowi.config.json`. */
  active: {
    storage: StorageDriver | null;
    search: SearchDriver | null;
    /** Auth and notifier are always lists — zero or more providers. */
    auth: AuthDriver[];
    notifiers: NotifierDriver[];
    /** Single active mail sender, selected by `mail.driver`. */
    mail: MailSender | null;
  };
}

/**
 * Loads the plugins listed in `crowi.config.json`, resolves their
 * dependency order, runs each plugin's `register*` callbacks, and
 * exposes the resulting registries to the rest of the application.
 *
 * Lifecycle:
 *   1. `loadCrowiConfigFile()` reads the JSON.
 *   2. For each plugin name, `await import(name)` pulls the package's
 *      default export and validates it as a `CrowiPlugin`.
 *   3. `topoSortPlugins()` orders by `requires`.
 *   4. For each plugin in order:
 *      a) build a `PluginContext` for it
 *      b) if first time loaded, `await onInstall(ctx)` (idempotency
 *         is the plugin's responsibility — we re-call on every boot
 *         until the install-tracker is added in a follow-up step)
 *      c) call each provided `register*` callback with the matching
 *         registry scope
 *   5. Resolve active drivers from `crowi.config.json:storage.driver`
 *      / `search.driver`. All registered auth and notifier drivers
 *      are active simultaneously.
 *
 * Errors at any step fail boot. The legacy boot path in `Crowi.init()`
 * is unchanged when `crowi.config.json` is absent — defaults
 * (`{ plugins: [], storage.driver: 'local', search.driver: 'mongo' }`)
 * mean the manager runs with only the implicit-default plugins.
 */
export class PluginManager {
  private storage = new DriverRegistry<StorageDriver>('storage');
  private search = new DriverRegistry<SearchDriver>('search');
  private auth = new DriverRegistry<AuthDriver>('auth');
  private notifier = new DriverRegistry<NotifierDriver>('notifier');
  private mail = new DriverRegistry<MailSender>('mail');
  private loadedPlugins: CrowiPlugin[] = [];
  /**
   * Plugins whose `activate()` threw during the last `bootstrap()` run,
   * with the error message that was thrown. Populated by `activateAll()`;
   * see `getFailedPlugins()`.
   */
  private failedPlugins: { plugin: CrowiPlugin; error: string }[] = [];
  /** plugin name → set of plugin names that `requires` it */
  private dependents = new Map<string, Set<string>>();

  constructor(private readonly crowi: Crowi) {}

  /**
   * Run the full lifecycle and return the resolved registries +
   * active drivers. Call once during `Crowi.init()`.
   */
  async bootstrap(projectDir: string = process.cwd()): Promise<PluginRegistries> {
    // `@crowi/runner` reads `crowi.config.json` and resolves each
    // plugin npm name (plus transitive `requires`) against the project
    // dir's `node_modules/`. Topological ordering, activation, and
    // registry wiring stay here in the manager — runner is a pure
    // config/loader library with no Crowi-runtime coupling.
    const { config, plugins } = await resolvePlugins(projectDir);
    debug('loaded crowi.config.json from %s: plugins=%o', projectDir, config.plugins);

    const ordered = topoSortPlugins(plugins);
    this.loadedPlugins = ordered;

    // Validate every plugin's `configSchema` entry point *before* any
    // zod/v3-dependent introspection runs. `listSensitiveKeys()` below
    // walks `Object.entries(schema.shape)` to find `@sensitive` fields —
    // a zod v4-native schema has a different internal shape, so that
    // walk would silently see nothing (or something meaningless) rather
    // than throw, and `@sensitive` detection would already be bypassed
    // for that plugin before boot ever reaches `activate()`'s own guard
    // (below, kept for direct/private-call coverage). Validating right
    // here, immediately after topo-sort and before `listSensitiveKeys()`,
    // closes that gap.
    this.assertAllConfigSchemas(ordered);

    // Register every plugin's `@sensitive`-marked configSchema fields
    // with the core sensitive-config registry so values written
    // through `configService.saveConfig('crowi', { 'plugin:…': … })`
    // are encrypted at rest just like legacy keys.
    registerSensitiveConfigKeys(this.listSensitiveKeys().map((k) => `crowi:${k}`));

    // Narrows `this.loadedPlugins` (currently == `ordered`, see above) down
    // to just the plugins that activated without throwing — `buildDependentsMap()`
    // and `resolveActiveDrivers()` below both read `this.loadedPlugins`, so they
    // automatically see the post-isolation set. See `activateAll()`.
    await this.activateAll(ordered);

    this.buildDependentsMap();
    this.crowi.getConfigService().onConfigChange((changedNamespaces, source) => this.handleConfigChange(changedNamespaces, source));

    return {
      storage: this.storage,
      search: this.search,
      auth: this.auth,
      notifier: this.notifier,
      mail: this.mail,
      active: this.resolveActiveDrivers(config),
    };
  }

  /**
   * Walk the loaded plugins' `requires` arrays and invert them into
   * `dependents: name → set of plugins that require it`. Used to fan
   * out `reconfigure` calls when a base plugin's config changes (e.g.
   * `@crowi/plugin-aws` credentials changing should reconfigure
   * `@crowi/plugin-storage-aws-s3`).
   */
  private buildDependentsMap(): void {
    this.dependents.clear();
    for (const plugin of this.loadedPlugins) {
      for (const dep of plugin.requires ?? []) {
        const set = this.dependents.get(dep) ?? new Set<string>();
        set.add(plugin.name);
        this.dependents.set(dep, set);
      }
    }
  }

  /**
   * Listener bound to ConfigService.onConfigChange. We only auto-fire
   * reconfigure for `'remote'` changes (= another instance saved via
   * Redis pub/sub). For `'local'` changes the admin save handler calls
   * `reconfigureAffected` itself so it can include the result in the
   * response body — running it here too would double-fire.
   */
  private async handleConfigChange(changedNamespaces: string[], source: ConfigChangeSource): Promise<void> {
    if (source !== 'remote') return;
    const affected = this.affectedPluginsFromNamespaces(changedNamespaces);
    if (affected.size === 0) return;
    await this.runReconfigure(affected);
  }

  /**
   * Resolve `changedNamespaces` (e.g. `['plugin:@crowi/plugin-aws']`)
   * to the concrete set of plugin names that need their `reconfigure`
   * called: the changed plugin itself plus every plugin that has it in
   * `requires`. The `'*'` sentinel (used by older pub/sub publishers)
   * fans out to every loaded plugin.
   */
  private affectedPluginsFromNamespaces(changedNamespaces: string[]): Set<string> {
    const out = new Set<string>();
    const queue: string[] = [];
    for (const ns of changedNamespaces) {
      if (ns === '*') {
        for (const plugin of this.loadedPlugins) out.add(plugin.name);
        continue;
      }
      const pluginName = parsePluginNamespace(ns);
      if (pluginName) queue.push(pluginName);
    }
    // BFS so transitive dependents are reached and a `requires` cycle
    // (shouldn't happen, but isn't actively prevented) doesn't loop.
    while (queue.length > 0) {
      const name = queue.shift()!;
      if (out.has(name)) continue;
      out.add(name);
      const dependents = this.dependents.get(name);
      if (dependents) for (const d of dependents) queue.push(d);
    }
    return out;
  }

  /**
   * Call `reconfigure(ctx)` on each plugin in `affected` that
   * implements it. Errors are logged + reported via the plugin's debug
   * logger but never propagated — a single misconfigured plugin must
   * not lock operators out of the admin UI.
   *
   * Returns whether any plugin both (a) implements reconfigure and
   * (b) completed without throwing — used by the admin save handler
   * to pick the right toast.
   */
  async runReconfigure(affected: Set<string>): Promise<{ attempted: number; succeeded: number }> {
    let attempted = 0;
    let succeeded = 0;
    for (const name of affected) {
      const plugin = this.getLoadedPlugin(name);
      if (!plugin?.reconfigure) continue;
      attempted++;
      const ctx = createPluginContext(plugin, this.crowi, this);
      try {
        await plugin.reconfigure(ctx);
        succeeded++;
        debug('reconfigure %s OK', name);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.warn(`[crowi:plugin:${name}] reconfigure failed: ${message}`);
        debug('reconfigure %s failed: %s', name, message);
      }
    }
    return { attempted, succeeded };
  }

  /**
   * Public entry-point used by the admin "save plugin config" handler
   * to await reconfigure completion in the same request and surface
   * the result in the response body.
   */
  async reconfigureAffected(changedNamespaces: string[]): Promise<{ attempted: number; succeeded: number }> {
    const affected = this.affectedPluginsFromNamespaces(changedNamespaces);
    return this.runReconfigure(affected);
  }

  /**
   * Look up a plugin by npm name from the loaded set. Used by
   * `PluginContext.dependencyConfig` to resolve another plugin's
   * configSchema. Returns undefined when the name isn't loaded.
   */
  getLoadedPlugin(name: string): CrowiPlugin | undefined {
    return this.loadedPlugins.find((p) => p.name === name);
  }

  /**
   * The list of plugins the manager loaded, in topological order.
   * Surfaced for `crowi plugin list` and admin UI.
   */
  getLoadedPlugins(): readonly CrowiPlugin[] {
    return this.loadedPlugins;
  }

  /**
   * Plugins whose `activate()` threw during the last `activateAll()` run
   * (i.e. the last `bootstrap()`), with the error message. These are
   * excluded from `getLoadedPlugins()` / `getLoadedPlugin()` — see
   * `activateAll()`. Surfaced by `GET /admin/plugins` as `status: 'failed'`
   * rows so operators can see and (via `crowi.config.json`) remove a
   * broken plugin without the rest of the app being unreachable.
   */
  getFailedPlugins(): readonly { plugin: CrowiPlugin; error: string }[] {
    return this.failedPlugins;
  }

  /**
   * Run `assertZodV3ConfigSchema()` over every plugin in `plugins` that
   * declares a `configSchema`, in order. Called once from `bootstrap()`
   * right after topo-sort — see the call site for why this must happen
   * before `listSensitiveKeys()` — and separately from each `activate()`
   * call for direct/private-call coverage (e.g. tests that invoke
   * `activate()` without going through `bootstrap()`).
   */
  private assertAllConfigSchemas(plugins: readonly CrowiPlugin[]): void {
    for (const plugin of plugins) {
      if (plugin.configSchema) {
        assertZodV3ConfigSchema(plugin.name, plugin.configSchema);
      }
    }
  }

  /**
   * Walk every loaded plugin's `configSchema` and return the union of
   * field paths marked `@sensitive`. The "re-encrypt all" admin
   * routine consults this list. See RFC-0001 §5.
   */
  listSensitiveKeys(): string[] {
    const out: string[] = [];
    for (const plugin of this.loadedPlugins) {
      const schema = plugin.configSchema;
      if (!schema) continue;
      for (const [fieldName, field] of Object.entries(schema.shape)) {
        const description = (field as { description?: string }).description;
        if (typeof description === 'string' && description.trimStart().startsWith('@sensitive')) {
          out.push(formatPluginConfigKey(plugin.name, fieldName));
        }
      }
    }
    return out;
  }

  /**
   * Walk `plugin.configSchema` (if any) and warn for every field whose
   * description starts with the `@action` marker but fails to parse
   * (`getActionAnnotation()` returns null) — same walk shape as
   * `listSensitiveKeys()`. The most common cause is a plugin author
   * declaring a verb `PluginRouteMethod` doesn't support (e.g. `PUT` /
   * `DELETE`, see `schema-markers.ts`): the annotation is silently
   * unparseable and the admin form renders no button, which is otherwise
   * a dead surface with no signal. This turns that into a boot-time log
   * line instead.
   */
  private warnOnMalformedActions(plugin: CrowiPlugin): void {
    const schema = plugin.configSchema;
    if (!schema) return;
    for (const [fieldName, field] of Object.entries(schema.shape)) {
      const description = field.description;
      if (typeof description !== 'string' || !description.trimStart().startsWith(ACTION_FIELD_MARKER)) continue;
      if (getActionAnnotation(field) !== null) continue;
      console.warn(
        `[crowi:plugin:${plugin.name}] config field '${fieldName}': @action annotation looks malformed (unsupported method) and will not render a button.`,
      );
    }
  }

  /**
   * Deactivate a loaded plugin. Phase 4 only touches the render
   * cache: every cached entry contributed by the named plugin is
   * removed (`invalidatePlugin(name)`). Phase 5+ will broaden this
   * to (a) drop the plugin from the loaded set + driver registries,
   * (b) emit a deactivation event for dependents, (c) wire the
   * `--purge` CLI path.
   *
   * Returns true when at least the render-cache invalidation ran
   * (false when the plugin wasn't loaded). Failures are logged but
   * never propagated — operators trigger deactivate from the admin
   * UI or CLI and a partial cleanup is still better than no cleanup.
   */
  async deactivate(name: string): Promise<boolean> {
    const plugin = this.getLoadedPlugin(name);
    if (!plugin) {
      debug('deactivate: plugin %s not loaded; nothing to do', name);
      return false;
    }
    try {
      const renderer = this.crowi.renderer;
      if (renderer) {
        await renderer.cache.invalidatePlugin(name);
        debug('deactivate %s: render-cache invalidated', name);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.warn(`[crowi:plugin:${name}] deactivate failed during render-cache invalidation: ${message}`);
    }
    return true;
  }

  /**
   * Call `activate()` on every plugin in `ordered`, isolating each call in
   * its own try/catch (same policy as `runReconfigure()` / `deactivate()`
   * — a single broken plugin must not prevent every other plugin, or the
   * rest of boot, from proceeding). A plugin whose `activate()` throws is
   * recorded in `failedPlugins` (see `getFailedPlugins()`) and excluded
   * from `this.loadedPlugins`; any `register*` calls it made before
   * throwing are intentionally not rolled back — the resulting
   * unresolved-driver-name path is handled by `resolveOrWarn()` below,
   * same as any other unregistered driver name.
   *
   * Extracted from `bootstrap()` (which pulls in a real `@crowi/runner`
   * config/plugin resolution) so it can be unit-tested directly against
   * synthetic plugins, matching the `assertAllConfigSchemas()` precedent.
   */
  private async activateAll(ordered: readonly CrowiPlugin[]): Promise<void> {
    const activated: CrowiPlugin[] = [];
    this.failedPlugins = [];
    for (const plugin of ordered) {
      try {
        await this.activate(plugin);
        activated.push(plugin);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.error(`[crowi:plugin:${plugin.name}] activation failed; plugin disabled: ${message}`);
        debug('activate %s failed: %s', plugin.name, message);
        this.failedPlugins.push({ plugin, error: message });
      }
    }
    this.loadedPlugins = activated;
  }

  private async activate(plugin: CrowiPlugin): Promise<void> {
    debug('activating %s@%s', plugin.name, plugin.version);
    const ctx = createPluginContext(plugin, this.crowi, this);

    if (plugin.configSchema) {
      assertZodV3ConfigSchema(plugin.name, plugin.configSchema);
    }

    this.warnOnMalformedActions(plugin);

    // onInstall runs unconditionally for now. A follow-up will track
    // installed-once state in Mongo and skip on subsequent boots.
    if (plugin.onInstall) {
      await plugin.onInstall(ctx);
    }

    if (plugin.registerStorage) plugin.registerStorage(makeStorageScope(this.storage, plugin.name), ctx);
    if (plugin.registerSearch) plugin.registerSearch(makeSearchScope(this.search, plugin.name), ctx);
    if (plugin.registerAuth) plugin.registerAuth(makeAuthScope(this.auth, plugin.name), ctx);
    if (plugin.registerNotifier) plugin.registerNotifier(makeNotifierScope(this.notifier, plugin.name), ctx);
    if (plugin.registerMailSender) plugin.registerMailSender(makeMailScope(this.mail, plugin.name), ctx);
    if (plugin.registerRenderer) {
      // Renderer is registered against `crowi.renderer.registry`; it
      // already has the core 4 transforms in place when we get here
      // (Crowi.init() runs setupRenderer before setupPlugins). External
      // plugins append to the back — they cannot insert before core in
      // v2.0 phase 2.
      const renderer = this.crowi.getRenderer();
      plugin.registerRenderer(makeRendererScope(renderer.registry, plugin.name, ctx.log), ctx);
    }

    // `registerRoutes` is intentionally NOT called here: the Hono app
    // does not exist yet at activation time (plugins activate during
    // `setupPlugins`, which runs before `buildHonoApp`). It is instead
    // invoked from `buildHonoApp`, which walks `getLoadedPlugins()` and
    // builds a per-plugin `makePluginRouterScope` over the live app
    // (RFC-0013 §4). `registerHooks` stays deferred — the EventBus is
    // not yet a wired extension point in v0.1.
  }

  private resolveActiveDrivers(config: CrowiConfigFile): PluginRegistries['active'] {
    return {
      storage: this.resolveOrWarn(this.storage, 'storage', config.storage.driver),
      search: this.resolveOrWarn(this.search, 'search', config.search.driver),
      auth: this.auth
        .list()
        .map(({ driverName }) => this.auth.get(driverName))
        .filter((d): d is AuthDriver => !!d),
      notifiers: this.notifier
        .list()
        .map(({ driverName }) => this.notifier.get(driverName))
        .filter((d): d is NotifierDriver => !!d),
      mail: this.resolveOrWarn(this.mail, 'mail', config.mail.driver),
    };
  }

  /**
   * Look up `driverName` in `registry`. Returns null + logs a warning
   * if absent. v2.0 transition behaviour: legacy in-core code keeps
   * handling the concern when the active driver is null. After the
   * Step 3+ plugin extractions land, missing-driver becomes a hard
   * error.
   */
  private resolveOrWarn<T>(registry: DriverRegistry<T>, kind: string, driverName: string): T | null {
    const driver = registry.get(driverName);
    if (driver) return driver;
    const installed =
      registry
        .list()
        .map((d) => d.driverName)
        .join(', ') || '(none)';
    debug(`[warn] ${kind}.driver '${driverName}' not registered. Installed: ${installed}. Falling back to legacy in-core handling.`);
    return null;
  }
}

/**
 * Verify that a plugin's `configSchema` was built from the `zod/v3`
 * compat entry point, not the top-level `zod` (v4) API.
 * `CrowiPlugin.configSchema` is typed against `zod/v3`'s `z.ZodObject`
 * (see `@crowi/plugin-api`'s `plugin.ts`), but that type only guides
 * authors who happen to import from the right subpath — nothing in
 * `peerDependencies: { zod: "^4" }` signals *which* entry point to use,
 * so a plugin author who reasonably reads that as "write against v4's
 * top-level API" ends up with a schema whose runtime shape every
 * introspection helper in this codebase (`schema-serializer.ts`,
 * `schema-markers.ts`, `listSensitiveKeys()`) silently fails to walk —
 * most importantly, `@sensitive` fields stop being detected and are
 * written to Mongo as plaintext (see the design-audit finding this
 * guard closes). `_def.typeName` is a marker zod v3 puts on every
 * schema node (`'ZodObject'` for `z.object(...)`); zod v4-native
 * schemas have a different internal shape and lack it, so this check
 * reliably tells the two apart without needing a real `instanceof`.
 */
function assertZodV3ConfigSchema(pluginName: string, schema: unknown): void {
  const typeName = (schema as { _def?: { typeName?: unknown } })?._def?.typeName;
  if (typeName === 'ZodObject') return;
  throw new Error(
    `Plugin '${pluginName}' declares configSchema built with the top-level 'zod' (v4) API. Import from 'zod/v3' instead — @crowi/plugin-api's config-schema introspection requires the zod v3 compat shape (see @crowi/plugin-api README).`,
  );
}
