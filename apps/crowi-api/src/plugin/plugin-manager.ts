import { createRequire } from 'node:module';
import path from 'node:path';
import Debug from 'debug';
import type { AuthDriver, CrowiPlugin, NotifierDriver, SearchDriver, StorageDriver } from '@crowi/plugin-api';
import type Crowi from 'src/crowi';
import { registerSensitiveConfigKeys } from 'src/models/config-sensitive';
import type { ConfigChangeSource } from 'src/service/config';
import { type CrowiConfigFile, loadCrowiConfigFile, resolvePluginList } from './config-file';
import { createPluginContext } from './plugin-context';
import { formatPluginConfigKey, parsePluginNamespace } from './plugin-namespace';
import { makeRendererScope } from 'src/renderer';
import { DriverRegistry, makeAuthScope, makeNotifierScope, makeSearchScope, makeStorageScope } from './registries';
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
  /** Active driver for each registry, resolved from `crowi.config.json`. */
  active: {
    storage: StorageDriver | null;
    search: SearchDriver | null;
    /** Auth and notifier are always lists — zero or more providers. */
    auth: AuthDriver[];
    notifiers: NotifierDriver[];
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
  private loadedPlugins: CrowiPlugin[] = [];
  /** plugin name → set of plugin names that `requires` it */
  private dependents = new Map<string, Set<string>>();

  constructor(private readonly crowi: Crowi) {}

  /**
   * Run the full lifecycle and return the resolved registries +
   * active drivers. Call once during `Crowi.init()`.
   */
  async bootstrap(projectDir: string = process.cwd()): Promise<PluginRegistries> {
    // Resolve plugin npm names against the runner project's
    // `node_modules/`. The runner declares plugins as deps, not
    // @crowi/api — so a bare `import('@crowi/plugin-…')` from this
    // file would search the wrong tree.
    const projectRequire = createRequire(path.join(projectDir, 'package.json'));
    const config = await loadCrowiConfigFile(projectDir);
    debug('loaded crowi.config.json from %s: plugins=%o', projectDir, config.plugins);

    const seedNames = resolvePluginList(config);
    const plugins = await this.importWithTransitives(seedNames, projectRequire);
    const ordered = topoSortPlugins(plugins);
    this.loadedPlugins = ordered;

    // Register every plugin's `@sensitive`-marked configSchema fields
    // with the core sensitive-config registry so values written
    // through `configService.saveConfig('crowi', { 'plugin:…': … })`
    // are encrypted at rest just like legacy keys.
    registerSensitiveConfigKeys(this.listSensitiveKeys().map((k) => `crowi:${k}`));

    for (const plugin of ordered) {
      await this.activate(plugin);
    }

    this.buildDependentsMap();
    this.crowi.getConfigService().onConfigChange((changedNamespaces, source) => this.handleConfigChange(changedNamespaces, source));

    return {
      storage: this.storage,
      search: this.search,
      auth: this.auth,
      notifier: this.notifier,
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
   * Import the given seed plugin names *and* recursively follow each
   * loaded plugin's `requires` array, importing any transitive deps
   * not already in the set. Lets the operator list only the leaf
   * plugins they care about (`@crowi/plugin-storage-aws-s3`) and have
   * base plugins (`@crowi/plugin-aws`) auto-loaded via npm transitive
   * resolution.
   */
  private async importWithTransitives(seedNames: string[], projectRequire: NodeRequire): Promise<CrowiPlugin[]> {
    const loaded = new Map<string, CrowiPlugin>();
    const queue = [...seedNames];

    while (queue.length > 0) {
      const name = queue.shift() as string;
      if (loaded.has(name)) continue;
      const plugin = await this.importOne(name, projectRequire);
      loaded.set(name, plugin);
      for (const dep of plugin.requires ?? []) {
        if (!loaded.has(dep)) queue.push(dep);
      }
    }

    return Array.from(loaded.values());
  }

  private async importOne(name: string, projectRequire: NodeRequire): Promise<CrowiPlugin> {
    let mod: { default?: unknown };
    try {
      const resolved = projectRequire.resolve(name);
      mod = (await import(resolved)) as { default?: unknown };
    } catch (err) {
      throw new Error(`Failed to import plugin '${name}': ${(err as Error).message}`);
    }
    const candidate = mod.default;
    if (!isCrowiPlugin(candidate)) {
      throw new Error(`Plugin '${name}' default export does not satisfy CrowiPlugin (missing name / version / register* hooks).`);
    }
    if (candidate.name !== name) {
      throw new Error(`Plugin '${name}' declares its own name as '${candidate.name}'. They must match.`);
    }
    return candidate;
  }

  private async activate(plugin: CrowiPlugin): Promise<void> {
    debug('activating %s@%s', plugin.name, plugin.version);
    const ctx = createPluginContext(plugin, this.crowi, this);

    // onInstall runs unconditionally for now. A follow-up will track
    // installed-once state in Mongo and skip on subsequent boots.
    if (plugin.onInstall) {
      await plugin.onInstall(ctx);
    }

    if (plugin.registerStorage) plugin.registerStorage(makeStorageScope(this.storage, plugin.name), ctx);
    if (plugin.registerSearch) plugin.registerSearch(makeSearchScope(this.search, plugin.name), ctx);
    if (plugin.registerAuth) plugin.registerAuth(makeAuthScope(this.auth, plugin.name), ctx);
    if (plugin.registerNotifier) plugin.registerNotifier(makeNotifierScope(this.notifier, plugin.name), ctx);
    if (plugin.registerRenderer) {
      // Renderer is registered against `crowi.renderer.registry`; it
      // already has the core 4 transforms in place when we get here
      // (Crowi.init() runs setupRenderer before setupPlugins). External
      // plugins append to the back — they cannot insert before core in
      // v2.1 phase 2.
      const renderer = this.crowi.getRenderer();
      plugin.registerRenderer(makeRendererScope(renderer.registry, plugin.name, ctx.log), ctx);
    }

    // registerHooks and registerRoutes are wired in a later step
    // (the EventBus and PluginRouterScope instances are not yet
    // constructed in v0.1).
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

const isCrowiPlugin = (value: unknown): value is CrowiPlugin => {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  return typeof v.name === 'string' && typeof v.version === 'string';
};
