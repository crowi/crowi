/**
 * @crowi/plugin-search-mongo — the default, infra-free search driver.
 *
 * Registers `'mongo'` against the SearchRegistry. It searches live data
 * (`Page` + the page's current `Revision`) with a case-insensitive
 * `$regex` over path / title / body, so it needs NO external service and
 * NO separate search index — MongoDB alone is enough. This makes the slim
 * deployment (local storage + mongo search) searchable out of the box.
 *
 * Positioning: small / mid-size wikis that don't want to run Elasticsearch.
 * A non-anchored `$regex` cannot use an index, so large installs should run
 * `@crowi/plugin-search-elasticsearch` instead — see README.
 *
 * Activation: set `search.driver: 'mongo'` in the runner's
 * `crowi.config.json` (the schema default) and ensure this plugin is loaded
 * (it is an implicit default in the runner). No connection config — the
 * config schema is empty.
 */

import { z } from 'zod/v3';
import type { CrowiPlugin } from '@crowi/plugin-api';

import { createMongoSearchDriver } from './driver';

export { createMongoSearchDriver, buildSnippet, CANDIDATE_CAP } from './driver';
export {
  buildPageFilter,
  grantFilter,
  typeFilter,
  pathPrefixFilter,
  keywordRegex,
  escapeRegex,
  clampLimit,
  pageToSkip,
  GRANT_PUBLIC,
  GRANT_RESTRICTED,
  GRANT_SPECIFIED,
  GRANT_OWNER,
  DEFAULT_LIMIT,
  MAX_LIMIT,
} from './query-builder';

const PLUGIN_NAME = '@crowi/plugin-search-mongo';

/**
 * The mongo driver has no connection settings — it searches the same
 * Mongo the rest of the app uses. The schema is intentionally empty so the
 * admin UI renders the driver with no config fields.
 */
export const MongoSearchConfigSchema = z.object({}).strict();

export type MongoSearchConfig = z.infer<typeof MongoSearchConfigSchema>;

const plugin: CrowiPlugin = {
  name: PLUGIN_NAME,
  version: '0.1.0-dev',
  configSchema: MongoSearchConfigSchema,
  // Read-only: driver.ts reads Page/Revision via ctx.model() for the
  // live $regex search; no writes.
  modelAccess: ['Page', 'Revision'],
  adminPlacement: {
    label: 'MongoDB',
    icon: 'database',
    // section omitted: derived from registerSearch -> 'search'
  },

  registerSearch: (registry, ctx) => {
    const driver = createMongoSearchDriver(ctx);
    registry.register('mongo', driver);
    ctx.log.debug('registered mongo search driver (live $regex over Page/Revision)');
  },
};

export default plugin;
