/**
 * @crowi/plugin-search-elasticsearch — search driver registering
 * `'elasticsearch'` against the SearchRegistry.
 *
 * Activation: add this plugin to the runner's `crowi.config.json`
 * `plugins` array and set `search.driver: 'elasticsearch'`. Configure
 * via the Mongo Config namespace `plugin:@crowi/plugin-search-elasticsearch:*`
 * (the legacy `ELASTICSEARCH_URI` / `BONSAI_URL` env values are
 * migrated into that namespace by `onInstall`).
 */

import { z } from 'zod';
import type { CrowiPlugin, PluginContext } from '@crowi/plugin-api';
import { createElasticsearchDriver, type Analyzer, type ElasticsearchDriver, type PageStreamDoc } from './driver';

export { createElasticsearchDriver } from './driver';
export type { ElasticsearchDriver, ElasticsearchDriverConfig, ElasticsearchDriverDeps, PageStreamDoc, Analyzer } from './driver';
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

const plugin: CrowiPlugin = {
  name: PLUGIN_NAME,
  version: '0.1.0-dev',
  configSchema: ElasticsearchConfigSchema,
  adminPlacement: {
    label: 'Elasticsearch',
    icon: 'search',
    // section omitted: derived from registerSearch -> 'shared' fallback
  },

  registerSearch: (registry, ctx) => {
    const config = ctx.config<ElasticsearchConfig>();

    if (!config.url) {
      ctx.log.warn('url is empty; the elasticsearch search driver is disabled until configured.');
      return;
    }

    const driver = buildDriver(config, ctx);
    registry.register('elasticsearch', driver);
    ctx.log.debug('registered elasticsearch search driver (node=%s, indexName=%s, analyzer=%s)', driver.node, driver.baseIndexName, config.analyzer);
  },

  onInstall: async (ctx) => {
    // Migrate legacy env-based URL into the plugin namespace so this
    // plugin is the single source of truth for ES connection info.
    const env = process.env;
    const fromEnv = env.ELASTICSEARCH_URI ?? env.BONSAI_URL ?? '';
    if (!fromEnv) return;

    let current: ElasticsearchConfig;
    try {
      current = ctx.config<ElasticsearchConfig>();
    } catch (err) {
      ctx.log.warn('config not yet readable during onInstall: %s', (err as Error).message);
      return;
    }
    if (current.url) {
      // Already configured via DB — don't overwrite.
      return;
    }
    await ctx.setConfig('url', fromEnv);
    ctx.log.info('migrated legacy ES URL from env into plugin config namespace.');
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

function buildDriver(config: ElasticsearchConfig, ctx: PluginContext): ElasticsearchDriver {
  const Page = ctx.model('Page') as PageModelLike;
  const Bookmark = ctx.model('Bookmark') as BookmarkModelLike;
  const User = ctx.model('User') as UserModelLike;

  return createElasticsearchDriver(
    {
      url: config.url,
      indexName: config.indexName,
      requestTimeout: config.requestTimeout,
      analyzer: config.analyzer,
    },
    {
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
    },
  );
}
