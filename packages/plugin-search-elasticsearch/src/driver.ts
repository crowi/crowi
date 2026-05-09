/**
 * Elasticsearch 8 driver implementing the `SearchDriver` contract.
 *
 * Responsibilities:
 *   - own the `@elastic/elasticsearch` v8 Client instance
 *   - manage the `${indexName}-current` alias (legacy ops compat)
 *   - index / delete pages on `index()` / `remove()` (single-doc API —
 *     bulk overhead doesn't pay off for one document)
 *   - run `query()` against the current alias
 *   - rebuild the index from scratch on `rebuild()`, bulk-indexing in
 *     2k-doc batches with bookmark counts pre-fetched in a single
 *     aggregate call
 *
 * Wire-format compatibility with the legacy ES7 indexer is preserved
 * for the document fields (path / body / username / grant /
 * granted_users / *_count / *_at) so an admin can switch between
 * legacy and plugin-based deployments without a reindex (provided
 * the cluster is already on ES8).
 */

import { Client, type ClientOptions } from '@elastic/elasticsearch';
import type { SearchDriver, SearchHits, SearchQuery, SearchableDoc, PluginLogger } from '@crowi/plugin-api';
import { parseQuery } from './parse-query';
import { buildSearchBody, type FunctionScoreParams } from './query-builder';
import defaultMapping from './mappings/default.json';
import kuromojiOverlay from './mappings/kuromoji.json';
import sudachiOverlay from './mappings/sudachi.json';

export type Analyzer = 'default' | 'kuromoji' | 'sudachi';

export interface ElasticsearchDriverConfig {
  url: string;
  indexName: string;
  requestTimeout: number;
  analyzer: Analyzer;
}

export interface ElasticsearchDriverDeps {
  log?: PluginLogger;
  /**
   * Iterate every page in the Mongo Page collection in cursor-style.
   * Plugin can't import the Page model directly, so the manager wires
   * this in from `ctx.model('Page')`. Each yielded doc is the lean
   * shape produced by `Page.getStreamOfFindAll({ publicOnly: false })`.
   */
  iteratePages?: (handler: (page: PageStreamDoc) => Promise<void>) => Promise<void>;
  /** Total page count, used for progress reporting. */
  countAllPages?: () => Promise<number>;
  /**
   * Bulk-fetch bookmark counts for every page in one Mongo aggregate.
   * Avoids the per-doc N+1 lookup the legacy rebuild used. Returns a
   * `Map<pageId, count>`; pages without bookmarks may be absent
   * (caller defaults to 0).
   */
  getBookmarkCountsBulk?: () => Promise<Map<string, number>>;
  /** Total user count, used to scale the bookmark-count factor. */
  countUsers?: () => Promise<number>;
}

/** The lean Page document shape we expect from the rebuild stream. */
export interface PageStreamDoc {
  _id: { toString: () => string } | string;
  path: string;
  redirectTo: string | null;
  status: string;
  grant: number;
  grantedUsers?: Array<{ toString: () => string } | string>;
  creator?: { username?: string };
  revision?: { body?: string };
  liker?: unknown[];
  commentCount?: number;
  bookmarkCount?: number;
  createdAt?: Date;
  updatedAt?: Date;
}

export interface ElasticsearchDriver extends SearchDriver {
  /** Currently-targeted alias name (`<indexName>-current`). Exposed for tests / admin UI. */
  readonly aliasName: string;
  /** ES node URI parsed out of `config.url`. */
  readonly node: string;
  /** Base index name (without timestamp / `-current` suffix). */
  readonly baseIndexName: string;
  /** Test-only handle to the underlying client. */
  readonly client: Client;
}

/** TTL for the cached user count used by the bookmark-count function-score factor. */
const USER_COUNT_TTL_MS = 5 * 60 * 1000;

export function createElasticsearchDriver(config: ElasticsearchDriverConfig, deps: ElasticsearchDriverDeps = {}): ElasticsearchDriver {
  const log = deps.log;
  const { node, indexName } = parseUri(config.url);
  const aliasName = `${indexName}-current`;

  const clientOpts: ClientOptions = {
    node,
    requestTimeout: config.requestTimeout,
  };
  const client = new Client(clientOpts);

  // Cached user count: refreshed on miss, every USER_COUNT_TTL_MS.
  // Avoids hammering Mongo with a full collection count on every
  // search query (the count only feeds a function-score factor, so
  // a stale value is fine).
  let userCountCache: { value: number; at: number } | null = null;
  const getCachedUserCount = async (): Promise<number | null> => {
    if (!deps.countUsers) return null;
    const now = Date.now();
    if (userCountCache && now - userCountCache.at < USER_COUNT_TTL_MS) {
      return userCountCache.value;
    }
    const value = await deps.countUsers();
    userCountCache = { value, at: now };
    return value;
  };

  const driver: ElasticsearchDriver = {
    aliasName,
    node,
    baseIndexName: indexName,
    client,

    async index(doc: SearchableDoc): Promise<void> {
      const source = docToEsSource(doc);
      await client.index({
        index: aliasName,
        id: doc.id,
        document: source as unknown as Record<string, unknown>,
      });
    },

    async remove(id: string): Promise<void> {
      try {
        await client.delete({ index: aliasName, id });
      } catch (err) {
        // Idempotent: a missing doc is fine. ES8 throws a
        // `ResponseError` with statusCode 404 when the id doesn't
        // exist; swallow only that case.
        if (isNotFoundError(err)) return;
        throw err;
      }
    },

    async query(q: SearchQuery): Promise<SearchHits> {
      const page = q.page && q.page > 0 ? q.page : 1;
      const limit = clampLimit(q.limit);
      const from = (page - 1) * limit;

      let functionScore: FunctionScoreParams | undefined;
      const userCount = await getCachedUserCount();
      if (userCount !== null) {
        const factor = 10000 / (userCount || 1);
        functionScore = {
          fieldValueFactor: { field: 'bookmark_count', modifier: 'log1p', factor, missing: 0 },
          boostMode: 'sum',
        };
      }

      const body = buildSearchBody({
        parsed: parseQuery(q.q),
        pathPrefix: q.pathPrefix,
        viewer: q.viewer,
        grants: q.grants,
        functionScore,
        from,
        size: limit,
      });

      const response = await client.search({
        index: aliasName,
        ...body,
      });

      const totalRaw = response.hits?.total;
      const total = typeof totalRaw === 'number' ? totalRaw : (totalRaw?.value ?? 0);

      const rawHits = (response.hits?.hits ?? []) as unknown as EsHit[];
      const hits = rawHits.map((h) => {
        const source = (h._source ?? {}) as { path?: string };
        const snippet = pickSnippet(h.highlight);
        return {
          id: String(h._id),
          path: source.path ?? '',
          score: typeof h._score === 'number' ? h._score : undefined,
          ...(snippet ? { snippet } : {}),
        };
      });

      return { total, hits };
    },

    async rebuild(): Promise<void> {
      if (!deps.iteratePages || !deps.countAllPages || !deps.getBookmarkCountsBulk) {
        throw new Error('@crowi/plugin-search-elasticsearch: rebuild() requires iteratePages / countAllPages / getBookmarkCountsBulk deps.');
      }

      const newIndexName = createTimestampedIndexName(indexName);
      log?.info('rebuild: creating index %s', newIndexName);

      const mapping = loadMapping(config.analyzer);
      await client.indices.create({ index: newIndexName, ...mapping });

      log?.info('rebuild: prefetching bookmark counts');
      const bookmarkCounts = await deps.getBookmarkCountsBulk();

      log?.info('rebuild: indexing all pages');
      await indexAllPages({
        client,
        indexTarget: newIndexName,
        iteratePages: deps.iteratePages,
        countAllPages: deps.countAllPages,
        bookmarkCounts,
        log,
      });

      log?.info('rebuild: switching alias %s -> %s', aliasName, newIndexName);
      await switchAlias(client, aliasName, newIndexName);

      log?.info('rebuild: cleaning up old indices');
      await deleteOldIndices(client, indexName, newIndexName);
    },
  };

  return driver;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

function clampLimit(limit: number | undefined): number {
  if (!limit || limit <= 0) return DEFAULT_LIMIT;
  return Math.min(limit, MAX_LIMIT);
}

/**
 * `BONSAI_URL` / `ELASTICSEARCH_URI` follow the format
 * `https://{ID}:{PASSWORD}@{HOST}[/{indexName}]`. Returns the node
 * URL for the SDK and the base index name.
 */
export function parseUri(uri: string): { node: string; indexName: string } {
  if (!uri.startsWith('http')) {
    throw new Error('URL for Elasticsearch should starts with http/https');
  }

  const esUrl = new URL(uri);
  const auth = esUrl.username && esUrl.password ? `${esUrl.username}:${esUrl.password}@` : '';
  const node = `${esUrl.protocol}//${auth}${esUrl.host}`;
  const indexName = esUrl.pathname && esUrl.pathname !== '/' ? esUrl.pathname.substring(1) : 'crowi';

  return { node, indexName };
}

/**
 * Index name format: `<base>-<utc-timestamp>-<random>`. The random
 * suffix prevents collision when two rebuilds start in the same
 * millisecond (rare but possible in CI / test setups). The format is
 * matched against `TS_INDEX_RE` in `deleteOldIndices` to guard against
 * accidentally deleting unrelated indices that happen to share the
 * `<base>-` prefix.
 */
function createTimestampedIndexName(base: string): string {
  const d = new Date();
  const pad = (n: number, w = 2): string => String(n).padStart(w, '0');
  const ts = `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}${pad(d.getUTCMilliseconds(), 3)}`;
  const rnd = Math.random().toString(36).slice(2, 6).padEnd(4, '0');
  return `${base}-${ts}-${rnd}`;
}

/** Matches the index name format produced by `createTimestampedIndexName`. */
const TS_INDEX_RE = /^.+-\d{17}-[a-z0-9]{4}$/;

type Mapping = Record<string, unknown>;

/**
 * Resolve the mapping for an analyzer. The `default.json` mapping is
 * the base; `kuromoji.json` / `sudachi.json` are overlays that add
 * the `*.ja` analyzer fields (and sudachi additionally registers the
 * `sudachi_*` analyzer / tokenizer in `settings.analysis`). The merge
 * is a small deep-merge of plain JSON objects — adequate for ES
 * mapping shapes which are nested-object-only.
 */
function loadMapping(analyzer: Analyzer): Mapping {
  const base = defaultMapping as Mapping;
  if (analyzer === 'default') return base;
  const overlay = (analyzer === 'kuromoji' ? kuromojiOverlay : sudachiOverlay) as Mapping;
  return deepMergeMappings(base, overlay);
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function deepMergeMappings(a: Mapping, b: Mapping): Mapping {
  const out: Record<string, unknown> = { ...a };
  for (const key of Object.keys(b)) {
    const av = a[key];
    const bv = b[key];
    if (isPlainObject(av) && isPlainObject(bv)) {
      out[key] = deepMergeMappings(av, bv);
    } else {
      out[key] = bv;
    }
  }
  return out;
}

interface BulkOp {
  index?: { _index: string; _id: string };
  delete?: { _index: string; _id: string };
}

interface PageRebuildContext {
  client: Client;
  indexTarget: string;
  iteratePages: NonNullable<ElasticsearchDriverDeps['iteratePages']>;
  countAllPages: NonNullable<ElasticsearchDriverDeps['countAllPages']>;
  bookmarkCounts: Map<string, number>;
  log?: PluginLogger;
}

async function indexAllPages(ctx: PageRebuildContext): Promise<void> {
  const allPageCount = await ctx.countAllPages();
  let operations: Array<BulkOp | Record<string, unknown>> = [];
  let total = 0;
  let skipped = 0;

  const flush = async (): Promise<void> => {
    if (operations.length === 0) return;
    try {
      const response = await ctx.client.bulk({
        operations,
        timeout: '1d',
      });
      if (response.errors) {
        ctx.log?.warn('rebuild: bulk had item-level errors (took=%dms)', response.took);
      }
    } catch (err) {
      ctx.log?.error('rebuild: bulk failed: %o', err);
    }
    operations = [];
  };

  await ctx.iteratePages(async (doc: PageStreamDoc) => {
    if (!doc.creator || !doc.revision || !shouldIndex(doc)) {
      skipped++;
      return;
    }
    total++;

    const id = typeof doc._id === 'string' ? doc._id : doc._id.toString();
    const bookmarkCount = ctx.bookmarkCounts.get(id) ?? 0;
    const source = pageStreamDocToEsSource(doc, bookmarkCount);

    operations.push({ index: { _index: ctx.indexTarget, _id: id } });
    operations.push(source as unknown as Record<string, unknown>);

    // Flush every 2000 documents (each doc = 2 operations).
    if (operations.length >= 4000) {
      await flush();
    }
  });

  await flush();
  ctx.log?.info('rebuild: indexed total=%d skipped=%d (allPageCount=%d)', total, skipped, allPageCount);
}

function shouldIndex(doc: PageStreamDoc): boolean {
  if (doc.redirectTo !== null && doc.redirectTo !== undefined) return false;
  if (doc.status === 'deleted') return false;
  return true;
}

async function switchAlias(client: Client, aliasName: string, newIndex: string): Promise<void> {
  const aliasInfo = await getCurrentAliasInfo(client, aliasName);

  const actions: Record<string, unknown>[] = [{ add: { index: newIndex, alias: aliasName } }];
  if (aliasInfo) {
    // Remove the alias from whatever index it currently points to.
    actions.push({ remove: { index: aliasInfo.index, alias: aliasName } });
  }

  await client.indices.updateAliases({ actions });
}

async function getCurrentAliasInfo(client: Client, aliasName: string): Promise<{ alias: string; index: string } | null> {
  try {
    const exists = await client.indices.existsAlias({ name: aliasName });
    if (!exists) return null;
  } catch {
    return null;
  }
  const aliases = await client.cat.aliases({ name: aliasName, format: 'json' });
  const list = aliases as unknown as Array<{ alias: string; index: string }>;
  return list.length > 0 ? { alias: list[0].alias, index: list[0].index } : null;
}

async function deleteOldIndices(client: Client, baseIndexName: string, keepIndexName: string): Promise<void> {
  // Server-side prefix filter so we don't pull every index in the
  // cluster — a Crowi cluster can be shared with other apps.
  const indices = await client.cat.indices({ index: `${baseIndexName}-*`, format: 'json' });
  const list = indices as unknown as Array<{ index: string }>;
  // Belt-and-braces: also enforce the timestamp format on the client
  // side. Anything matching `<base>-*` but lacking the 17-digit
  // timestamp + 4-char random suffix is left alone (could be a
  // hand-created index named `<base>-staging` etc.).
  const toDelete = list.map((i) => i.index).filter((name) => name.startsWith(`${baseIndexName}-`) && name !== keepIndexName && TS_INDEX_RE.test(name));
  if (toDelete.length === 0) return;
  await client.indices.delete({ index: toDelete });
}

function isNotFoundError(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const e = err as { statusCode?: number; meta?: { statusCode?: number } };
  return e.statusCode === 404 || e.meta?.statusCode === 404;
}

// ---------------------------------------------------------------------------
// Document shape conversion
// ---------------------------------------------------------------------------

/**
 * Single source of truth for the ES doc field names. `query-builder.ts`
 * uses these too where applicable; bringing them onto one constant
 * makes a future rename / extension a single-file change.
 */
export const ES_FIELDS = {
  path: 'path',
  body: 'body',
  username: 'username',
  grant: 'grant',
  grantedUsers: 'granted_users',
  commentCount: 'comment_count',
  bookmarkCount: 'bookmark_count',
  likeCount: 'like_count',
  createdAt: 'created_at',
  updatedAt: 'updated_at',
} as const;

interface EsPageSource {
  path: string;
  body: string;
  username?: string;
  grant?: number;
  granted_users?: string[];
  comment_count?: number;
  bookmark_count?: number;
  like_count?: number;
  created_at?: Date | string;
  updated_at?: Date | string;
}

/**
 * SearchableDoc -> ES page source. Plugin-API only mandates id / path
 * / body; everything else we look up in `meta.*` for the keys the
 * legacy indexer produced. Unknown / missing keys are simply omitted
 * (mapping is non-strict, so ES tolerates that).
 */
export function docToEsSource(doc: SearchableDoc): EsPageSource {
  const meta = (doc.meta ?? {}) as Record<string, unknown>;
  const source: EsPageSource = {
    path: doc.path,
    body: doc.body,
  };
  const username = readString(meta.username);
  if (username !== undefined) source.username = username;
  const grant = readNumber(meta.grant);
  if (grant !== undefined) source.grant = grant;
  const grantedUsers = readStringArray(meta.granted_users ?? meta.grantedUsers);
  if (grantedUsers !== undefined) source.granted_users = grantedUsers;
  const commentCount = readNumber(meta.comment_count ?? meta.commentCount);
  if (commentCount !== undefined) source.comment_count = commentCount;
  const bookmarkCount = readNumber(meta.bookmark_count ?? meta.bookmarkCount);
  if (bookmarkCount !== undefined) source.bookmark_count = bookmarkCount;
  const likeCount = readNumber(meta.like_count ?? meta.likeCount);
  if (likeCount !== undefined) source.like_count = likeCount;
  const createdAt = readDateLike(meta.created_at ?? meta.createdAt);
  if (createdAt !== undefined) source.created_at = createdAt;
  const updatedAt = readDateLike(meta.updated_at ?? meta.updatedAt);
  if (updatedAt !== undefined) source.updated_at = updatedAt;
  return source;
}

/**
 * Project a `PageStreamDoc` (Mongo lean shape) into a `SearchableDoc`
 * and route through the canonical `docToEsSource`. Centralises
 * the meta key vocabulary so we have one place to evolve.
 */
function pageStreamDocToEsSource(doc: PageStreamDoc, bookmarkCount: number): EsPageSource {
  const grantedUsers = (doc.grantedUsers ?? []).map((u) => (typeof u === 'string' ? u : u.toString()));
  const searchable: SearchableDoc = {
    id: typeof doc._id === 'string' ? doc._id : doc._id.toString(),
    path: doc.path,
    body: doc.revision?.body ?? '',
    meta: {
      username: doc.creator?.username,
      grant: doc.grant,
      granted_users: grantedUsers,
      comment_count: doc.commentCount ?? 0,
      bookmark_count: bookmarkCount,
      like_count: doc.liker?.length ?? 0,
      created_at: doc.createdAt,
      updated_at: doc.updatedAt,
    },
  };
  return docToEsSource(searchable);
}

interface EsHit {
  _id: unknown;
  _score?: number;
  _source?: unknown;
  highlight?: Record<string, string[]>;
}

function pickSnippet(highlight: Record<string, string[]> | undefined): string | undefined {
  if (!highlight) return undefined;
  // Prefer Japanese body, then English body, then path. Pick the first
  // fragment for each — ES sorts within a field by score so the first
  // is the most relevant.
  for (const field of ['body.ja', 'body', 'path.ja', 'body.en', 'path.en']) {
    const fragments = highlight[field];
    if (fragments && fragments.length > 0) return fragments[0];
  }
  return undefined;
}

function readString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function readNumber(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  return undefined;
}

function readStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const out: string[] = [];
  for (const v of value) {
    if (typeof v === 'string') out.push(v);
    else if (v && typeof v === 'object' && typeof (v as { toString?: () => string }).toString === 'function') {
      out.push((v as { toString: () => string }).toString());
    }
  }
  return out;
}

function readDateLike(value: unknown): Date | string | undefined {
  if (value instanceof Date) return value;
  if (typeof value === 'string') return value;
  return undefined;
}
