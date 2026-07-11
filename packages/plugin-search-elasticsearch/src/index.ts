/**
 * @crowi/plugin-search-elasticsearch — search driver registering
 * `'elasticsearch'` against the SearchRegistry.
 *
 * Activation: add this plugin to the runner's `crowi.config.json`
 * `plugins` array and set `search.driver: 'elasticsearch'`. Configure
 * via the Mongo Config namespace `plugin:@crowi/plugin-search-elasticsearch:*`
 * — operators set the connection URL exclusively from the admin UI.
 */

import { z } from 'zod/v3';
import type { CrowiPlugin, PluginContext } from '@crowi/plugin-api';
import {
  applyConfig,
  applyConfigInPlace,
  createElasticsearchDriver,
  type Analyzer,
  type ElasticsearchDriver,
  type ElasticsearchDriverConfig,
  type ESDriverState,
  type PageStreamDoc,
} from './driver';

export { applyConfig, applyConfigInPlace, createElasticsearchDriver } from './driver';
export type { ElasticsearchDriver, ElasticsearchDriverConfig, ElasticsearchDriverDeps, ESDriverState, PageStreamDoc, Analyzer } from './driver';
export { parseQuery } from './parse-query';
export { buildSearchBody } from './query-builder';

export const ElasticsearchConfigSchema = z
  .object({
    /**
     * `https://[user:pass@]host[:port][/indexName]`. Empty string keeps
     * the driver registered but disabled — `query()` will throw a
     * helpful error and `index()` becomes a no-op.
     *
     * Marked `@sensitive` because the URL embeds the cluster password
     * (Bonsai-style `https://USER:PASS@HOST/INDEX`); we don't want
     * Mongo to keep it in plaintext.
     */
    url: z.string().describe('@sensitive Elasticsearch endpoint (https://USER:PASS@HOST/INDEX format).').default(''),
    /**
     * Base index name. Used as the `indexName` if not provided in the
     * URL path. The runtime alias `${indexName}-current` is what the
     * driver actually targets for read / write.
     */
    indexName: z.string().default('crowi'),
    requestTimeout: z.number().int().positive().default(5000),
    /**
     * Mapping flavour. Cluster requirements:
     *   - `default`: no extra ES plugin.
     *   - `kuromoji`: `analysis-kuromoji` plugin (Elastic-distributed).
     *     The dev image (`elasticsearch.Dockerfile`) preinstalls it.
     *   - `sudachi`: third-party `analysis-sudachi` plugin + dictionary.
     *     NOT bundled in the dev image; operators must build a derived
     *     image. Picking this without the plugin makes `rebuild()` fail.
     */
    analyzer: z
      .enum(['default', 'kuromoji', 'sudachi'])
      .describe('default / kuromoji (analysis-kuromoji plugin) / sudachi (analysis-sudachi plugin + dictionary, custom image required)')
      .default('default'),
  })
  .strict();

export type ElasticsearchConfig = z.infer<typeof ElasticsearchConfigSchema>;

const PLUGIN_NAME = '@crowi/plugin-search-elasticsearch';

/**
 * Module-scope driver state ref. `registerSearch` initialises it from
 * the boot-time config and registers a driver bound to it; the driver
 * methods snapshot from it on every call; `reconfigure` mutates its
 * fields in place when admin saves new connection / index / analyzer /
 * requestTimeout values. The single-instance assumption is fine — the
 * plugin registers exactly one `'elasticsearch'` driver, owned by this
 * module. `null` before `registerSearch` runs.
 */
let state: ESDriverState | null = null;

function toDriverConfig(config: ElasticsearchConfig): ElasticsearchDriverConfig {
  return {
    url: config.url,
    indexName: config.indexName,
    requestTimeout: config.requestTimeout,
    analyzer: config.analyzer,
  };
}

const plugin: CrowiPlugin = {
  name: PLUGIN_NAME,
  version: '0.1.0-dev',
  configSchema: ElasticsearchConfigSchema,
  // Read-only: driver.ts / index.ts read Page/Bookmark/User via
  // ctx.model() to build search documents and resolve grants; no
  // writes.
  modelAccess: ['Page', 'Bookmark', 'User'],
  adminPlacement: {
    label: 'Elasticsearch',
    icon: 'search',
    // section omitted: derived from registerSearch -> 'search'
  },

  registerSearch: (registry, ctx) => {
    const config = ctx.config<ElasticsearchConfig>();

    if (!config.url) {
      ctx.log.warn('url is empty; the elasticsearch search driver is disabled until configured.');
      // NOTE: empty-url -> configured-url is restart-only. The driver
      // is not registered here, so `reconfigure` has nothing to mutate
      // back into; the operator restarts after first configuring a url.
      return;
    }

    state = applyConfig(toDriverConfig(config));
    const driver = buildDriver(state, ctx);
    registry.register('elasticsearch', driver);
    ctx.log.debug('registered elasticsearch search driver (node=%s, indexName=%s, analyzer=%s)', driver.node, driver.baseIndexName, config.analyzer);
  },

  reconfigure: (ctx) => {
    if (!state) {
      // registerSearch skipped (boot-time url was empty). Configuring a
      // url now needs a restart — see the registerSearch note above.
      ctx.log.warn('reconfigure: driver was not registered at boot (url was empty); a server restart is required to enable Elasticsearch search.');
      return;
    }
    const config = ctx.config<ElasticsearchConfig>();
    if (!config.url) {
      ctx.log.warn('reconfigure: url cleared; search requests will fail with a "Search not configured" error until a url is set.');
    }
    const { oldClient } = applyConfigInPlace(state, toDriverConfig(config));
    // Fire-and-forget: the ES Client keeps an HTTP keep-alive pool, so
    // the old one must be closed — but awaiting it would block the
    // admin save response. Inflight requests already snapshotted the
    // old client and drain to completion regardless.
    if (oldClient) {
      void oldClient.close().catch((err: unknown) => {
        ctx.log.warn('reconfigure: closing the previous Elasticsearch client failed: %o', err);
      });
    }
    ctx.log.debug('reconfigured elasticsearch search driver (node=%s, index=%s, analyzer=%s)', state.node || '<unset>', state.baseIndexName, config.analyzer);
  },
};

export default plugin;

// ---------------------------------------------------------------------------
// Wiring helpers — visible for tests.
// ---------------------------------------------------------------------------

interface PageModelLike {
  allPageCount: () => Promise<number>;
  getStreamOfFindAll: (opts: { publicOnly: boolean }) => {
    eachAsync: (handler: (doc: PageStreamDoc) => Promise<void>) => Promise<void>;
  };
}

interface BookmarkAggregateRow {
  _id: { toString: () => string } | string;
  n: number;
}

interface BookmarkModelLike {
  aggregate: (pipeline: unknown[]) => Promise<BookmarkAggregateRow[]>;
}

interface UserModelLike {
  countDocuments: (q?: unknown) => { exec: () => Promise<number> };
}

function buildDriver(driverState: ESDriverState, ctx: PluginContext): ElasticsearchDriver {
  const Page = ctx.model('Page') as PageModelLike;
  const Bookmark = ctx.model('Bookmark') as BookmarkModelLike;
  const User = ctx.model('User') as UserModelLike;

  return createElasticsearchDriver(driverState, {
    log: ctx.log,
    iteratePages: async (handler) => {
      const cursor = Page.getStreamOfFindAll({ publicOnly: false });
      await cursor.eachAsync(handler);
    },
    countAllPages: () => Page.allPageCount(),
    getBookmarkCountsBulk: async () => {
      // One Mongo aggregate -> Map<pageId, count>. Replaces the
      // legacy per-doc `Bookmark.countByPageId` lookup that was
      // O(N) round-trips during a full rebuild.
      const rows = await Bookmark.aggregate([{ $group: { _id: '$page', n: { $sum: 1 } } }]);
      const map = new Map<string, number>();
      for (const row of rows) {
        const key = typeof row._id === 'string' ? row._id : row._id.toString();
        map.set(key, row.n);
      }
      return map;
    },
    countUsers: () => User.countDocuments({}).exec(),
  });
}
