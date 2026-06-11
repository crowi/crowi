import { createRequire } from 'node:module';
import path from 'node:path';
import type { CrowiPlugin } from '@crowi/plugin-api';
import { type CrowiConfigFile, loadCrowiConfigFile, resolvePluginList } from './config-file';

/**
 * Result of `resolvePlugins`: the parsed config file plus the resolved
 * plugin instances (deduplicated, transitively expanded — *not* topo
 * sorted).
 *
 * Ordering of `plugins` is "seed-first then BFS over `requires`": the
 * names listed in `IMPLICIT_DEFAULT_PLUGINS + config.plugins` (in that
 * order) appear first, with transitively-required plugins following.
 * Consumers that care about lifecycle order must run their own topo
 * sort on top — `@crowi/runner` deliberately stops short of that to
 * stay decoupled from any specific runtime (Crowi class / mongoose /
 * etc.).
 */
export interface ResolvedPlugins {
  config: CrowiConfigFile;
  plugins: CrowiPlugin[];
}

/**
 * Read `crowi.config.json` from `projectDir`, resolve the listed
 * plugin npm names (plus transitive `requires`) against that project's
 * `node_modules/`, and return the parsed config + the imported plugin
 * instances.
 *
 * `projectDir` defaults to `process.cwd()` so a runner / CLI invoked
 * from its own working tree gets the natural behaviour. Pass an
 * explicit directory when the caller knows its location independently
 * of CWD (e.g. tests, embedded uses).
 */
export async function resolvePlugins(projectDir: string = process.cwd()): Promise<ResolvedPlugins> {
  // Resolve plugin npm names against the runner project's
  // `node_modules/`. The runner declares plugins as deps, not
  // `@crowi/api` itself — so a bare `import('@crowi/plugin-…')` from
  // inside the api package would search the wrong tree.
  const projectRequire = createRequire(path.join(projectDir, 'package.json'));
  const config = await loadCrowiConfigFile(projectDir);
  const seedNames = resolvePluginList(config);
  const plugins = importWithTransitives(seedNames, projectRequire);
  return { config, plugins };
}

// BFS the seed names and their transitive `requires`, deduplicated by
// plugin name. Returns in first-occurrence order (seeds first, then
// transitives). Sync because plugin tarballs ship CJS — see importPlugin.
//
// Resolution context matters. The seed names are the runner project's own
// declared deps, so they resolve from the project root (`projectRequire`). A
// plugin's transitive `requires` (e.g. `@crowi/plugin-storage-aws-s3` requires
// `@crowi/plugin-aws`), however, are deps of *that plugin*, not of the runner
// project — under `pnpm deploy --prod` they live in the requiring plugin's own
// `node_modules`, not hoisted to the project root. So we resolve each plugin's
// `requires` from *that plugin's* location. (Resolving from the root only
// happened to work inside the dev monorepo, where `.npmrc` public-hoist makes
// every `@crowi/plugin-*` resolvable from the root; it broke in a real deployed
// image — caught by the prod Docker boot smoke.)
function importWithTransitives(seedNames: string[], projectRequire: NodeRequire): CrowiPlugin[] {
  const loaded = new Map<string, CrowiPlugin>();
  const queue: Array<{ name: string; require: NodeRequire }> = seedNames.map((name) => ({ name, require: projectRequire }));

  while (queue.length > 0) {
    const { name, require: req } = queue.shift() as { name: string; require: NodeRequire };
    if (loaded.has(name)) continue;
    const { plugin, resolvedPath } = importPlugin(name, req);
    loaded.set(name, plugin);
    // Build a require rooted at this plugin's entry file so its transitive
    // `requires` resolve from its own `node_modules`.
    const childRequire = createRequire(resolvedPath);
    for (const dep of plugin.requires ?? []) {
      if (!loaded.has(dep)) queue.push({ name: dep, require: childRequire });
    }
  }

  return Array.from(loaded.values());
}

// Uses Node CJS `require` rather than `await import(...)`: every Crowi
// plugin tarball ships a CJS entry, and using `require` keeps this
// loader working under ts-jest's CJS transform without needing
// `--experimental-vm-modules`. ESM-only plugins are intentionally
// unsupported in Crowi 2.0 (the api itself is CJS-only via Express /
// mongoose / passport).
//
// Returns the plugin plus its resolved entry path so the caller can build a
// `createRequire` rooted at this plugin for resolving its transitive `requires`.
function importPlugin(name: string, pluginRequire: NodeRequire): { plugin: CrowiPlugin; resolvedPath: string } {
  let resolvedPath: string;
  let mod: { default?: unknown };
  try {
    resolvedPath = pluginRequire.resolve(name);
    mod = pluginRequire(resolvedPath) as { default?: unknown };
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
  return { plugin: candidate, resolvedPath };
}

const isCrowiPlugin = (value: unknown): value is CrowiPlugin => {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  return typeof v.name === 'string' && typeof v.version === 'string';
};
