import Debug from 'debug';
import { ACTION_FIELD_MARKER, getActionAnnotation } from '@crowi/plugin-api';
import type {
  AuthDriver,
  CrowiPlugin,
  MailSender,
  NotifierDriver,
  PluginReadinessDeclaration,
  SearchDriver,
  StateCell,
  StorageDriver,
} from '@crowi/plugin-api';
import { type CrowiConfigFile, resolvePlugins } from '@crowi/runner';
import type Crowi from 'src/crowi';
import { registerSensitiveConfigKeys } from 'src/models/config-sensitive';
import type { ConfigChangeSource } from 'src/service/config';
import { CORE_READINESS_DECLARATIONS } from './core-readiness';
import { credentialVaultModelNamesList, isCredentialVaultModel } from './credential-vault-models';
import { createPluginContext } from './plugin-context';
import { isPluginInstalled, markPluginInstalled } from './plugin-install-tracker';
import { atomicConfigGroupKey } from 'src/models/config';
import { formatPluginConfigKey, formatPluginNamespace, parsePluginNamespace, readCrowiConfigNamespace } from './plugin-namespace';
import { createStateCell } from './plugin-state-cell';
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
 * The registries a plugin's `readiness` declaration can be scoped to
 * (feature-plugin-config-readiness).
 */
type ReadinessRegistry = PluginReadinessDeclaration['registry'];

/** One unset `requiredConfigFields` entry — never carries the actual value. */
export interface PluginReadinessFieldResult {
  name: string;
  configured: false;
}

/**
 * A loaded, active plugin with at least one unset readiness field. The
 * handler resolves this into the wire `ConfigReadinessIssue` via
 * `resolvePlacement(plugin)` + the existing plugin-edit-href convention —
 * this shape carries only enough (`pluginName`) for that lookup.
 */
export interface PluginManagerReadinessIssue {
  source: 'plugin';
  /** `plugin:<pluginName>` — mirrors the plugin's own config namespace prefix (`formatPluginNamespace`). */
  id: string;
  pluginName: string;
  fields: PluginReadinessFieldResult[];
}

/**
 * A core config declaration (`core-readiness.ts`, feature-core-config-
 * readiness-and-mail) with at least one unset field. `label`/`href` are
 * copied straight from the declaration — the handler needs no further
 * HTTP-layer knowledge to build the wire issue.
 */
export interface CoreManagerReadinessIssue {
  source: 'core';
  id: string;
  label: string;
  href: string;
  fields: PluginReadinessFieldResult[];
}

/**
 * Union returned by `getReadinessIssues()`.
 *
 * Deliberately NOT named `ConfigReadinessIssue`: that name belongs to the
 * WIRE shape in `@crowi/api-contract` (which carries `label` + `href`
 * directly rather than `pluginName`), and the hono handler converts this
 * into that one. Sharing the identifier for two different shapes in two
 * packages a reader can have open at once is how they get confused — same
 * reason `getFailedPlugins()` returns its own internal shape rather than
 * reusing the wire-level `PluginInfo` name.
 */
export type ManagerReadinessIssue = PluginManagerReadinessIssue | CoreManagerReadinessIssue;

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
 *      b) if the plugin declares `onInstall` and has never completed
 *         it before (per the `plugin-installed` Config namespace, see
 *         plugin-install-tracker.ts), `await onInstall(ctx)` and
 *         record completion — subsequent boots skip it
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
  /**
   * The driver name selected per registry in `crowi.config.json`, kept
   * regardless of whether a plugin actually registered that driver name
   * (e.g. Elasticsearch/OpenSearch with an empty `url` — see
   * `registerSearch`'s early return in those plugins). Populated by
   * `bootstrap()`; `getReadinessIssues()` reads it to know which
   * plugin's `readiness` declaration is "currently selected" without
   * depending on registry registration state. Defaults mirror
   * `CrowiConfigFileSchema`'s own defaults so a manager queried before
   * `bootstrap()` (shouldn't happen in practice) still answers sanely.
   */
  private selectedDrivers: Record<ReadinessRegistry, string> = { storage: 'local', search: 'mongo', mail: 'smtp' };
  /**
   * plugin name → its `PluginContext.state()` cell. Backs
   * `getOrCreateStateCell()` — one cell per plugin, shared across the
   * activation-time `ctx` and every later `reconfigure(ctx)` for that
   * plugin (see `createPluginContext`'s `state` field).
   */
  private stateCells = new Map<string, StateCell<unknown>>();

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

    // Kept independent of driver *registration* — a plugin can select
    // itself out of registering (e.g. Elasticsearch/OpenSearch with an
    // empty `url`) without losing "this is the driver the operator
    // picked" for `getReadinessIssues()`. See the field doc above.
    this.selectedDrivers = { storage: config.storage.driver, search: config.search.driver, mail: config.mail.driver };

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
    this.assertAllConfigAtomicGroups(ordered);

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
   * Evaluate every loaded plugin's `readiness` declaration (if any) plus
   * every static core declaration (`CORE_READINESS_DECLARATIONS`,
   * feature-core-config-readiness-and-mail) against the driver selected
   * in `crowi.config.json` (see `selectedDrivers`, set by `bootstrap()`)
   * and the live core config namespace (`crowi.getConfig().crowi`, the
   * same in-memory cache `saveConfig`/`loadAllConfig` maintain). Not
   * cached — each call re-reads the live config, so a save made moments
   * earlier is already reflected.
   *
   * A plugin is a candidate only when it declares `readiness` AND that
   * declaration's `registry`/`driver` matches the currently selected
   * driver for that registry — independent of whether the driver
   * actually got registered (Elasticsearch/OpenSearch with an empty
   * `url` never call `registry.register(...)`, but are still the
   * "selected" driver; see AC-3). A candidate is only returned when at
   * least one of its `requiredConfigFields` is empty/null/undefined —
   * plugins with everything configured, or with no readiness
   * declaration, or that are not the selected driver, are omitted
   * entirely. Core declarations have no driver gate — they are always
   * evaluated — but are otherwise held to the same "at least one unset
   * field" omission rule.
   *
   * Returns ONLY field names + `configured: false` — never the actual
   * config value (including secrets, e.g. `@sensitive`-marked URLs).
   * `packages/api/src/hono/handlers/admin/plugins.ts`'s readiness GET
   * handler maps this internal result onto the public response schema
   * (adding each plugin's `adminPlacement` for a plugin issue, or the
   * declaration's own `label`/`href` for a core issue), so this method
   * never needs to know about the HTTP layer.
   */
  getReadinessIssues(): ManagerReadinessIssue[] {
    const configNamespace = this.getCrowiConfigNamespace();
    const issues: ManagerReadinessIssue[] = [];
    for (const plugin of this.loadedPlugins) {
      const readiness = plugin.readiness;
      if (!readiness || !readiness.driver) continue;
      if (this.selectedDrivers[readiness.registry] !== readiness.driver) continue;

      const unsetFields = readiness.requiredConfigFields.filter(
        (field) => field.length > 0 && !isReadinessFieldConfigured(configNamespace[formatPluginConfigKey(plugin.name, field)]),
      );
      if (unsetFields.length === 0) continue;

      issues.push({
        source: 'plugin',
        id: formatPluginNamespace(plugin.name),
        pluginName: plugin.name,
        fields: unsetFields.map((name) => ({ name, configured: false as const })),
      });
    }

    for (const declaration of CORE_READINESS_DECLARATIONS) {
      const unsetFields = declaration.fields.filter((field) => !isReadinessFieldConfigured(configNamespace[field.configKey]));
      if (unsetFields.length === 0) continue;

      issues.push({
        source: 'core',
        id: declaration.id,
        label: declaration.label,
        href: declaration.href,
        fields: unsetFields.map((field) => ({ name: field.name, configured: false as const })),
      });
    }

    return issues;
  }

  /** Defensive read of `crowi.getConfig().crowi` — see {@link readCrowiConfigNamespace}. */
  private getCrowiConfigNamespace(): Record<string, unknown> {
    return readCrowiConfigNamespace(this.crowi.getConfig());
  }

  /**
   * Backs `PluginContext.state()` (see `PluginLookup.getOrCreateStateCell`
   * in `plugin-context.ts`). One cell per plugin name, created lazily on
   * first call and reused by every later call — including calls from a
   * *different* `PluginContext` instance for the same plugin, which is
   * exactly what happens between activation (`registerStorage` etc.) and
   * a later `reconfigure()`, each of which gets its own `ctx`.
   *
   * Not cleaned up on `deactivate()` — see the class doc for why a full
   * plugin unload is deferred to Phase 5+.
   */
  getOrCreateStateCell<T>(pluginName: string, initial: T): StateCell<T> {
    const existing = this.stateCells.get(pluginName) as StateCell<T> | undefined;
    if (existing) return existing;
    const cell = createStateCell(initial);
    this.stateCells.set(pluginName, cell as StateCell<unknown>);
    return cell;
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
   * RFC-0014 phase 4 — validate `configAtomicGroups` at boot, before any
   * value is ever written through them. A malformed declaration (an
   * unknown field, a field claimed by two groups, an empty or duplicated
   * group) would otherwise only surface as a corrupted or unreachable
   * config document long after the fact, so this fails the boot instead.
   */
  private assertAllConfigAtomicGroups(plugins: readonly CrowiPlugin[]): void {
    for (const plugin of plugins) {
      const groups = plugin.configAtomicGroups;
      if (!groups || groups.length === 0) continue;

      const schemaFields = plugin.configSchema ? new Set(Object.keys(plugin.configSchema.shape)) : new Set<string>();
      const seenGroupNames = new Set<string>();
      const claimedFields = new Map<string, string>();

      for (const group of groups) {
        if (!group.name || group.name.includes(':')) {
          throw new Error(
            `[crowi:plugin:${plugin.name}] configAtomicGroups: group name must be non-empty and contain no ':' (got ${JSON.stringify(group.name)})`,
          );
        }
        if (seenGroupNames.has(group.name)) {
          throw new Error(`[crowi:plugin:${plugin.name}] configAtomicGroups: duplicate group name '${group.name}'`);
        }
        seenGroupNames.add(group.name);

        if (!group.keys || group.keys.length === 0) {
          throw new Error(`[crowi:plugin:${plugin.name}] configAtomicGroups: group '${group.name}' declares no keys`);
        }
        for (const key of group.keys) {
          if (!schemaFields.has(key)) {
            throw new Error(`[crowi:plugin:${plugin.name}] configAtomicGroups: group '${group.name}' names '${key}', which is not a configSchema field`);
          }
          const claimedBy = claimedFields.get(key);
          if (claimedBy) {
            throw new Error(
              `[crowi:plugin:${plugin.name}] configAtomicGroups: field '${key}' is claimed by both '${claimedBy}' and '${group.name}' — a field belongs to at most one group`,
            );
          }
          claimedFields.set(key, group.name);
        }
      }
    }
  }

  /**
   * Walk every loaded plugin's `configSchema` and return the union of
   * field paths marked `@sensitive`. The "re-encrypt all" admin
   * routine consults this list. See RFC-0001 §5.
   *
   * A field stored inside a `sensitive` atomic group is reported as the
   * GROUP's physical key rather than its own: that field has no row of
   * its own to encrypt, and registering its flat key would tell the
   * encryption layer to protect something that is never written (RFC-0014
   * phase 4).
   */
  listSensitiveKeys(): string[] {
    const out: string[] = [];
    for (const plugin of this.loadedPlugins) {
      const groups = plugin.configAtomicGroups ?? [];
      const fieldsInSensitiveGroup = new Set(groups.filter((g) => g.sensitive).flatMap((g) => g.keys));
      for (const group of groups) {
        if (group.sensitive) out.push(atomicConfigGroupKey(plugin.name, group.name));
      }

      const schema = plugin.configSchema;
      if (!schema) continue;
      for (const [fieldName, field] of Object.entries(schema.shape)) {
        if (fieldsInSensitiveGroup.has(fieldName)) continue;
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

    if (plugin.modelAccess) {
      assertValidModelAccess(plugin.name, plugin.modelAccess, Object.keys(this.crowi.models));
    }

    this.warnOnMalformedActions(plugin);

    // onInstall runs once per plugin, ever — install-once state is
    // tracked in a dedicated Mongo Config namespace (see
    // plugin-install-tracker.ts) so it survives across boots and
    // across the plugin being temporarily removed from
    // `crowi.config.json` and re-added later. The record is only
    // written after `onInstall` completes without throwing, so a
    // failed `onInstall` is retried on the next boot.
    if (plugin.onInstall && !isPluginInstalled(this.crowi, plugin.name)) {
      await plugin.onInstall(ctx);
      await markPluginInstalled(this.crowi, plugin.name);
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
 * Whether a single readiness-declared config field counts as "set", per
 * `getReadinessIssues()`. Mirrors `isFieldValueSet()`
 * (`packages/web/src/components/admin/plugin-deps-banner.tsx`) for a
 * plain (non-secret) value: `false`/`0` are valid configured values,
 * only empty/null/undefined (and an empty array, for forward
 * compatibility with a future array-typed readiness field) count as
 * unset. There is no separate secret-object case here — unlike the
 * admin config-form response, this reads the raw in-memory Config
 * value directly (e.g. `@sensitive` URLs are stored as plain strings in
 * `crowi.getConfig()`, only masked when serialised for the admin form).
 */
function isReadinessFieldConfigured(value: unknown): boolean {
  if (value === null || value === undefined) return false;
  if (typeof value === 'string' && value.length === 0) return false;
  if (Array.isArray(value) && value.length === 0) return false;
  return true;
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

/**
 * Verify that every entry in a plugin's `modelAccess` declaration names
 * a real core model, and that none of them names a credential-vault
 * model (feature-plugin-capability-hardening). `Crowi.init()` runs
 * `setupModels()` before `setupPlugins()` (see `crowi/index.ts`), so
 * `validModelNames` — read from `this.crowi.models` at the `activate()`
 * call site — is already complete by the time this runs. An unknown
 * model name is very likely a typo (`modelAccess: ['Pages']` instead of
 * `['Page']`) that would otherwise silently make `ctx.model('Pages')`
 * throw the *unrelated* "did not declare it in 'modelAccess'" error at
 * first use, deep inside a `register*` callback — surfacing it here, at
 * boot, names the offending plugin immediately instead.
 *
 * The credential-vault check runs first: `Config` / `PersonalAccessToken`
 * / `OAuthClient` / etc. (see `credential-vault-models.ts`) are always
 * real, registered core models, so without this ordering they would
 * otherwise pass the "is it a known model" check silently. There is no
 * legitimate plugin use case for declaring one — see the module doc on
 * `CREDENTIAL_VAULT_MODEL_NAMES`. `ctx.model()` re-checks this at call
 * time (`plugin-context.ts`) as defense-in-depth, so boot validation is
 * never the only barrier.
 */
function assertValidModelAccess(pluginName: string, modelAccess: readonly string[], validModelNames: readonly string[]): void {
  const validSet = new Set(validModelNames);
  for (const name of modelAccess) {
    if (isCredentialVaultModel(name)) {
      throw new Error(
        `Plugin '${pluginName}' declares modelAccess including '${name}', but credential-bearing core models cannot be granted to plugins. Denied models: ${credentialVaultModelNamesList()}.`,
      );
    }
    if (!validSet.has(name)) {
      throw new Error(
        `Plugin '${pluginName}' declares modelAccess including '${name}', which is not a registered core model. Valid model names: ${validModelNames.join(', ')}.`,
      );
    }
  }
}
