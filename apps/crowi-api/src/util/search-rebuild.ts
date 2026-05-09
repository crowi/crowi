import type Crowi from 'src/crowi';

/**
 * Plugin-agnostic dispatcher for `crowi-admin search rebuild`. Resolves
 * the active search driver and delegates to its `rebuild()` method.
 *
 * The actual rebuild semantics live in each plugin's driver
 * (`packages/plugin-search-elasticsearch/src/driver.ts:rebuild` and
 * future opensearch / algolia drivers). Keeping this wrapper to a
 * single delegating call means new search backends don't have to touch
 * admin-cli or the api repo to wire up `crowi-admin search rebuild` —
 * they only have to implement the `SearchDriver.rebuild?()` contract
 * declared in `@crowi/plugin-api`.
 */
export interface SearchRebuildSummary {
  driverName: string;
  pluginName: string;
}

export async function runSearchRebuild(crowi: Crowi): Promise<SearchRebuildSummary> {
  const plugins = crowi.getPlugins();
  const driver = plugins.active.search;
  if (!driver) {
    throw new Error('No active search driver. Set `search.driver` in crowi.config.json and install the matching plugin.');
  }
  if (typeof driver.rebuild !== 'function') {
    throw new Error('The active search driver does not support rebuild. (Plugins without a persistent index — e.g. Mongo regex — are read-only.)');
  }

  // Resolve the (driverName, pluginName) for the summary by walking the
  // registry list and matching by reference. Same approach the admin
  // status endpoint uses — see `routes/ts-rest/admin/search.ts`.
  let driverName = '<unknown>';
  let pluginName = '<unknown>';
  for (const entry of plugins.search.list()) {
    if (plugins.search.get(entry.driverName) === driver) {
      driverName = entry.driverName;
      pluginName = entry.plugin;
      break;
    }
  }

  await driver.rebuild();
  return { driverName, pluginName };
}
