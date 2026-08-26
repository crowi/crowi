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
import { Client } from '@elastic/elasticsearch';
import type { CrowiPlugin, PluginConfigVerificationResult, PluginContext, StateCell, VerificationFailureReason } from '@crowi/plugin-api';
import {
  applyConfig,
  createElasticsearchDriver,
  parseUri,
  type Analyzer,
  type ElasticsearchDriver,
  type ElasticsearchDriverConfig,
  type ESDriverState,
  type PageStreamDoc,
} from './driver';

export { applyConfig, createElasticsearchDriver } from './driver';
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
 * `true` once `registerSearch` has actually registered a driver (i.e.
 * boot-time `url` was non-empty and it created the `ctx.state()` cell).
 * `registerSearch` intentionally does *not* register a driver at all
 * when `url` is empty (see its NOTE below), so this — not "does the
 * cell exist" — is what `reconfigure` checks to tell "never configured,
 * restart required" apart from "configured, then `url` was cleared via
 * a later `reconfigure`" (the cell exists and its `client` is `null` in
 * both cases). A plain boot-time flag, not a hand-rolled resource state
 * — the actual driver-owned resource (the ES `Client`) lives entirely
 * in the `StateCell` from `ctx.state()`.
 *
 * Reset to `false` at the top of every `registerSearch` call (not just
 * set to `true` on success): a real process only ever calls
 * `registerSearch` once per plugin, but the module itself is a
 * singleton, so anything that re-invokes it against the same module
 * instance (tests re-running "boot" with a different config, a future
 * reactivate-without-restart path) must not see a stale `true` left
 * over from an earlier, unrelated activation.
 */
let activatedAtBoot = false;

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
  // `url` defaults to '' (a valid Zod value) but `registerSearch` above
  // skips registering a driver entirely until it's set — see
  // feature-plugin-config-readiness.
  readiness: {
    registry: 'search',
    driver: 'elasticsearch',
    requiredConfigFields: ['url'],
  },

  registerSearch: (registry, ctx) => {
    // Reset first — see the doc comment on `activatedAtBoot` above for
    // why this can't just be a one-way `= true` on the success path.
    activatedAtBoot = false;
    const config = ctx.config<ElasticsearchConfig>();

    if (!config.url) {
      ctx.log.warn('url is empty; the elasticsearch search driver is disabled until configured.');
      // NOTE: empty-url -> configured-url is restart-only. The driver
      // is not registered here, so `reconfigure` has nothing to mutate
      // back into; the operator restarts after first configuring a url.
      return;
    }

    const cell = ctx.state<ESDriverState>(applyConfig(toDriverConfig(config)));
    activatedAtBoot = true;
    const driver = buildDriver(cell, ctx);
    registry.register('elasticsearch', driver);
    ctx.log.debug('registered elasticsearch search driver (node=%s, indexName=%s, analyzer=%s)', driver.node, driver.baseIndexName, config.analyzer);
  },

  reconfigure: (ctx) => {
    if (!activatedAtBoot) {
      // registerSearch skipped (boot-time url was empty). Configuring a
      // url now needs a restart — see the registerSearch note above.
      ctx.log.warn('reconfigure: driver was not registered at boot (url was empty); a server restart is required to enable Elasticsearch search.');
      return;
    }
    const config = ctx.config<ElasticsearchConfig>();
    if (!config.url) {
      ctx.log.warn('reconfigure: url cleared; search requests will fail with a "Search not configured" error until a url is set.');
    }
    const next = applyConfig(toDriverConfig(config));
    const cell = ctx.state<ESDriverState>(next);
    cell.set(next, {
      // The ES Client keeps an HTTP keep-alive pool, so the old one
      // must be closed — but this now runs only once every in-flight
      // `withValue()` call against it (index/remove/query/rebuild) has
      // settled (AC-3's drain-after behaviour), not fire-and-forget the
      // instant `reconfigure` returns.
      dispose: (prev) => {
        if (!prev.client) return;
        prev.client.close().catch((err: unknown) => {
          ctx.log.warn('reconfigure: closing the previous Elasticsearch client failed: %o', err);
        });
      },
    });
    ctx.log.debug('reconfigured elasticsearch search driver (node=%s, index=%s, analyzer=%s)', next.node || '<unset>', next.baseIndexName, config.analyzer);
  },

  // feature-plugin-config-live-verification — snapshot-only, non-blocking,
  // info-only (no index/document read-write, no round-trip object): a
  // single `client.info()` call against a throwaway client built from the
  // snapshot's own config, closed when done. Index/alias/analyzer/rebuild
  // correctness stays entirely out of scope — this only confirms the
  // cluster is reachable and the credentials in `url` are accepted.
  verifyConfig: async (snapshot) => {
    const config = snapshot.config<ElasticsearchConfig>();
    return probeElasticsearchCluster(config);
  },
};

export default plugin;

// ---------------------------------------------------------------------------
// feature-plugin-config-live-verification — verification probe
// ---------------------------------------------------------------------------

/**
 * A single `client.info()` call against a one-shot client built directly
 * from `config` — never `applyConfig`/the driver's hot-reload `StateCell`.
 * `maxRetries: 0` (a verification probe must not silently retry into the
 * caller's timeout budget) and `requestTimeout` capped at 10s regardless
 * of what the operator configured, so an operator-set multi-minute
 * `requestTimeout` can't stall this probe past the manager's own 10s race
 * (feature-plugin-config-live-verification §3/§4). Always closes the
 * client before returning — no persistent connection left behind.
 */
export async function probeElasticsearchCluster(config: ElasticsearchConfig): Promise<PluginConfigVerificationResult> {
  let client: Client;
  try {
    const { node } = parseUri(config.url);
    client = new Client({ node, requestTimeout: resolveVerificationRequestTimeout(config.requestTimeout), maxRetries: 0 });
  } catch (err) {
    // Most likely an empty/malformed `url` — not one of the classified
    // driver exceptions in §3's table, so 'unknown' is the honest reason.
    return { status: 'failed', reason: classifyElasticsearchError(err) };
  }

  try {
    await client.info();
    return { status: 'ok' };
  } catch (err) {
    return { status: 'failed', reason: classifyElasticsearchError(err) };
  } finally {
    await client.close().catch(() => {
      // Best-effort close — never lets a teardown failure surface as (or
      // override) the probe's own result.
    });
  }
}

/** Caps an operator-configured `requestTimeout` at 10s for a verification probe — a multi-minute configured timeout must never stall this probe past the caller's own 10s hook-level race (feature-plugin-config-live-verification §3/§4). */
export function resolveVerificationRequestTimeout(configuredRequestTimeoutMs: number): number {
  return Math.min(configuredRequestTimeoutMs, 10_000);
}

const ES_CONNECTION_ERROR_NAMES = new Set(['ConnectionError', 'TimeoutError', 'NoLivingConnectionsError']);

/**
 * Classify an Elasticsearch client failure into the fixed reason set
 * (feature-plugin-config-live-verification §3's table). Anything not
 * explicitly listed there falls into `'unknown'`.
 */
export function classifyElasticsearchError(err: unknown): VerificationFailureReason {
  const statusCode = extractStatusCode(err);
  if (statusCode === 401 || statusCode === 403) return 'auth-failed';
  if (statusCode === 404) return 'resource-missing';
  const name = (err as { name?: unknown } | undefined)?.name;
  if (typeof name === 'string' && ES_CONNECTION_ERROR_NAMES.has(name)) return 'unreachable';
  return 'unknown';
}

/** Same shape `driver.ts`'s `isNotFoundError` reads: the ES client puts the HTTP status either directly on the error or under `.meta.statusCode`. */
function extractStatusCode(err: unknown): number | undefined {
  if (!err || typeof err !== 'object') return undefined;
  const e = err as { statusCode?: unknown; meta?: { statusCode?: unknown } };
  if (typeof e.statusCode === 'number') return e.statusCode;
  if (typeof e.meta?.statusCode === 'number') return e.meta.statusCode;
  return undefined;
}

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

function buildDriver(cell: StateCell<ESDriverState>, ctx: PluginContext): ElasticsearchDriver {
  const Page = ctx.model('Page') as PageModelLike;
  const Bookmark = ctx.model('Bookmark') as BookmarkModelLike;
  const User = ctx.model('User') as UserModelLike;

  return createElasticsearchDriver(cell, {
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
