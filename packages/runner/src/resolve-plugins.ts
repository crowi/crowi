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
function importWithTransitives(seedNames: string[], projectRequire: NodeRequire): CrowiPlugin[] {
  const loaded = new Map<string, CrowiPlugin>();
  const queue = [...seedNames];

  while (queue.length > 0) {
    const name = queue.shift() as string;
    if (loaded.has(name)) continue;
    const plugin = importPlugin(name, projectRequire);
    loaded.set(name, plugin);
    for (const dep of plugin.requires ?? []) {
      if (!loaded.has(dep)) queue.push(dep);
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
function importPlugin(name: string, projectRequire: NodeRequire): CrowiPlugin {
  let mod: { default?: unknown };
  try {
    const resolved = projectRequire.resolve(name);
    mod = projectRequire(resolved) as { default?: unknown };
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

const isCrowiPlugin = (value: unknown): value is CrowiPlugin => {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  return typeof v.name === 'string' && typeof v.version === 'string';
};
