import type { CrowiPlugin } from '@crowi/plugin-api';

/**
 * Topologically sort the loaded plugins so each plugin's `requires`
 * are processed (registered) before the plugin itself. A `requires`
 * entry that points at a plugin not in the input set is ignored
 * (already-loaded core defaults / sibling plugins): we only sort what
 * we have.
 *
 * @throws on cycle, naming the plugins involved
 * @throws on a `requires` entry that genuinely cannot be resolved
 *         (i.e. neither in the input set nor declared as
 *         "already-loaded"). The caller controls "already loaded"
 *         via `alreadyLoaded`.
 */
export function topoSortPlugins(plugins: CrowiPlugin[], alreadyLoaded: ReadonlySet<string> = new Set()): CrowiPlugin[] {
  const byName = new Map<string, CrowiPlugin>();
  for (const p of plugins) {
    if (byName.has(p.name)) {
      throw new Error(`Plugin '${p.name}' loaded twice — duplicate npm package?`);
    }
    byName.set(p.name, p);
  }

  // Validate `requires` references resolve.
  for (const p of plugins) {
    for (const dep of p.requires ?? []) {
      if (!byName.has(dep) && !alreadyLoaded.has(dep)) {
        throw new Error(`Plugin '${p.name}' requires '${dep}', which is not installed.`);
      }
    }
  }

  // Standard DFS topo with cycle detection.
  const visited = new Set<string>();
  const visiting = new Set<string>();
  const order: CrowiPlugin[] = [];

  const visit = (name: string, trail: string[]): void => {
    if (visited.has(name)) return;
    if (visiting.has(name)) {
      throw new Error(`Plugin dependency cycle detected: ${[...trail, name].join(' → ')}`);
    }
    const plugin = byName.get(name);
    if (!plugin) return; // already-loaded dep, not in this batch
    visiting.add(name);
    for (const dep of plugin.requires ?? []) {
      visit(dep, [...trail, name]);
    }
    visiting.delete(name);
    visited.add(name);
    order.push(plugin);
  };

  for (const p of plugins) {
    visit(p.name, []);
  }

  return order;
}
