import type Crowi from 'src/crowi';
import { runBootMigrations } from 'src/migration/run-boot-migrations';
import type { BootLayer } from 'src/util/boot-reporter';
import { runOAuthClientSeed } from 'src/util/oauth-client-seed';

/**
 * A single boot step, declarative enough that `runInitLayers()` (the
 * server's `init()`) and `initForCli()` (`@crowi/admin-cli`'s lightweight
 * init) can both derive their sequence from the same `ALL_BOOT_STEPS` array
 * via `resolveBootOrder()` instead of hand-listing steps twice — see
 * `.feature-state/specs/feature-boot-sequence-declarative.md`.
 */
export interface BootStep {
  name: string;
  /** Display-only grouping consumed by `runInitLayers()`'s reporter.beginLayer/endLayer. Does not affect ordering. */
  layer: BootLayer;
  /** Names of steps that must run before this one (backward references only — see `ALL_BOOT_STEPS`' ordering note below). */
  after?: string[];
  /**
   * Label `runInitLayers()`'s `step()` timing wrapper passes to `bootDebug`
   * (the `DEBUG=crowi:boot` phase name). Optional — falls back to `name`.
   * Set on every `ALL_BOOT_STEPS` entry below to reproduce the exact
   * `setupXxx`/`runXxx` labels the old hand-written `step('setupEncryption',
   * ...)` calls emitted before this file existed, so pre-existing
   * `DEBUG=crowi:boot` output is unchanged (AC-11). A newly added step with
   * no prior debug label can simply omit this and let it default to `name`.
   */
  debugLabel?: string;
  run: (crowi: Crowi, ctx: { mode: 'server' | 'cli' }) => void | Promise<void>;
}

/**
 * The full boot sequence, in `runInitLayers()`'s current execution order.
 *
 * Ordering note: every `after` entry here references a step that appears
 * *earlier* in this array. `resolveBootOrder()`'s DFS pushes a node only
 * once all of its `after` deps are already pushed, so as long as every dep
 * is a backward reference, iterating the array top-level and visiting each
 * name in turn reproduces this exact array order in the output — the
 * topological sort is a no-op on an already-sorted input. Do not add a
 * forward reference (an `after` naming a step that appears later in this
 * array); doing so would make `resolveBootOrder(ALL_BOOT_STEPS)` reorder
 * relative to this list, silently changing `runInitLayers()`'s behaviour.
 */
export const ALL_BOOT_STEPS: BootStep[] = [
  {
    name: 'encryption',
    layer: 'core',
    debugLabel: 'setupEncryption',
    run: (crowi) => crowi.setupEncryption(),
  },
  {
    name: 'database',
    layer: 'core',
    debugLabel: 'setupDatabase',
    run: async (crowi) => {
      await crowi.setupDatabase();
    },
  },
  {
    name: 'models',
    layer: 'core',
    debugLabel: 'setupModels',
    run: (crowi) => crowi.setupModels(),
  },
  {
    name: 'redis',
    layer: 'core',
    debugLabel: 'setupRedisClient',
    run: (crowi) => crowi.setupRedisClient(),
  },
  {
    name: 'config',
    layer: 'config',
    after: ['models'],
    debugLabel: 'setupConfig',
    run: (crowi) => crowi.setupConfig(),
  },
  {
    name: 'bootMigrations',
    layer: 'config',
    after: ['config'],
    debugLabel: 'runBootMigrations',
    run: async (crowi) => {
      await runBootMigrations(crowi);
    },
  },
  {
    name: 'seedOAuthClients',
    layer: 'config',
    // Idempotent upsert ($setOnInsert) — runs after setupModels so the
    // OAuthClient model is registered; disjoint from the migrations above.
    after: ['models'],
    debugLabel: 'seedOAuthClients',
    run: (crowi) => runOAuthClientSeed(crowi),
  },
  {
    name: 'renderer',
    layer: 'services',
    // Renderer must boot BEFORE plugins so PluginManager.activate() can hand
    // plugins a registry that already has the core 4 transforms (TOC /
    // wikilinks / mentions / codeBlockLanguages) registered.
    after: ['config', 'models'],
    debugLabel: 'setupRenderer',
    // CLI mode skips the page-save side-effect listeners (mention dispatch /
    // render-cache invalidation) — a bulk migration's updatePage writes must
    // not @-ping users or race the CLI's teardown connection close.
    run: (crowi, ctx) => crowi.setupRenderer(ctx.mode === 'cli' ? { registerPageEventListeners: false } : undefined),
  },
  {
    name: 'plugins',
    layer: 'services',
    // Plugins must boot AFTER config/models are ready (so PluginContext can
    // read config and access models) and after the renderer (see above).
    after: ['config', 'models', 'renderer'],
    debugLabel: 'setupPlugins',
    run: (crowi) => crowi.setupPlugins(),
  },
  {
    name: 'mailer',
    layer: 'services',
    // Migrating to plugin-provided drivers; any conflict should fail
    // noisily after plugins have booted.
    after: ['plugins'],
    debugLabel: 'setupMailer',
    run: (crowi) => crowi.setupMailer(),
  },
  {
    name: 'lru',
    layer: 'services',
    debugLabel: 'setupLRU',
    run: (crowi) => crowi.setupLRU(),
  },
];

/**
 * Boot steps `initForCli()` (`@crowi/admin-cli`'s lightweight init) omits:
 * Redis / mailer / search / LRU / the boot-time migration framework — the
 * migration belongs to the long-running server so it runs the DB-mutating
 * migration exactly once; the CLI shouldn't mutate Mongo as a side effect
 * of starting up. Named here as a single set so "what does the CLI skip"
 * is readable in one place instead of re-derived from which six steps
 * `initForCli()` happens to call.
 */
export const CLI_SKIP_STEPS: ReadonlySet<string> = new Set(['redis', 'bootMigrations', 'seedOAuthClients', 'mailer', 'lru']);

/**
 * Topologically sort `steps` by their `after` edges. Mirrors
 * `plugin/topo-sort.ts`'s `topoSortPlugins()` (DFS + `visiting`/`visited` +
 * `trail`-based cycle reporting) with the vocabulary read as `after`/`skip`
 * instead of `requires`/`alreadyLoaded` — kept as a deliberate duplicate
 * rather than a shared helper (see spec 未確定事項 1: two call sites don't
 * justify the abstraction yet).
 *
 * `options.skip` removes the named steps from the output while treating
 * any other step's `after` reference to a skipped name as already
 * satisfied — this is *not* the same as `topoSortPlugins`'s
 * `alreadyLoaded`, which only ever describes names outside the input set.
 * Here a skipped name IS declared in `steps`; it is simply never visited
 * into the output. This is what lets `initForCli()` omit `redis` /
 * `bootMigrations` / `seedOAuthClients` / `mailer` / `lru` without the
 * steps that (harmlessly, for the other boot path) reference them via
 * `after` failing to resolve.
 *
 * @throws on a duplicate step name.
 * @throws on an `after` entry that resolves to neither a declared step nor
 *         a skipped name.
 * @throws on a cycle, naming the steps involved.
 */
export function resolveBootOrder(steps: BootStep[], options: { skip?: ReadonlySet<string> } = {}): BootStep[] {
  const skip = options.skip ?? new Set<string>();

  const byName = new Map<string, BootStep>();
  for (const s of steps) {
    if (byName.has(s.name)) {
      throw new Error(`Boot step '${s.name}' declared twice.`);
    }
    byName.set(s.name, s);
  }

  // Validate `after` references resolve — either declared in this batch or
  // explicitly named in `skip` (in which case the dependent's edge is
  // considered satisfied without the dependency ever running).
  for (const s of steps) {
    for (const dep of s.after ?? []) {
      if (!byName.has(dep) && !skip.has(dep)) {
        throw new Error(`Boot step '${s.name}' requires '${dep}', which is not declared.`);
      }
    }
  }

  const visited = new Set<string>();
  const visiting = new Set<string>();
  const order: BootStep[] = [];

  const visit = (name: string, trail: string[]): void => {
    if (visited.has(name)) return;
    if (visiting.has(name)) {
      // Report only the cycle itself, from the first re-encounter of `name`
      // — not the acyclic prefix in `trail` that merely led into it.
      const cycle = trail.slice(trail.indexOf(name));
      throw new Error(`Boot step dependency cycle detected: ${[...cycle, name].join(' → ')}`);
    }
    if (skip.has(name)) {
      // Excluded from the output — but mark visited so any step depending
      // on it treats the edge as already satisfied, same as `alreadyLoaded`
      // in `topoSortPlugins`.
      visited.add(name);
      return;
    }
    const step = byName.get(name);
    if (!step) return; // validated above — reachable only via a skip-only dep name that isn't declared here
    visiting.add(name);
    for (const dep of step.after ?? []) {
      visit(dep, [...trail, name]);
    }
    visiting.delete(name);
    visited.add(name);
    order.push(step);
  };

  for (const s of steps) {
    visit(s.name, []);
  }

  return order;
}
