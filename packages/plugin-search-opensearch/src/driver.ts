/**
 * OpenSearch driver implementing the `SearchDriver` contract. Owns
 * the Client, the `${indexName}-current` alias (legacy ops compat),
 * single-doc index / remove, query against the alias, and rebuild-
 * from-scratch in 2k-doc bulk batches with bookmark counts pre-fetched
 * in one aggregate. Document field shape (path / body / username /
 * grant / granted_users / *_count / *_at) matches the ES plugin's
 * shape so a cluster migration is a re-point + rebuild rather than a
 * mapping rewrite.
 *
 * SDK note: `@opensearch-project/opensearch` 3.x returns
 * `{ body, statusCode, ... }` wrappers around every API response (the
 * shape inherited from the old `elasticsearch-js` 7.x line). The
 * Elasticsearch 9 client we use for `@crowi/plugin-search-elasticsearch`
 * collapsed those wrappers — so every call site here unwraps `body`
 * explicitly. Bulk requests likewise take `{ body: operations }`, not
 * the ES 9 `{ operations }` keyword.
 */

import { Client } from '@opensearch-project/opensearch';

type ClientOptions = NonNullable<ConstructorParameters<typeof Client>[0]>;
import type { SearchDriver, SearchHits, SearchQuery, SearchableDoc, PluginLogger } from '@crowi/plugin-api';
import { parseQuery } from './parse-query';
import { buildSearchBody, type FunctionScoreParams } from './query-builder';
import defaultMapping from './mappings/default.json';
import kuromojiOverlay from './mappings/kuromoji.json';
import sudachiOverlay from './mappings/sudachi.json';

export type Analyzer = 'default' | 'kuromoji' | 'sudachi';

export interface OpenSearchDriverConfig {
  url: string;
  indexName: string;
  requestTimeout: number;
  analyzer: Analyzer;
}

export interface OpenSearchDriverDeps {
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

export interface OpenSearchDriver extends SearchDriver {
  /** Currently-targeted alias name (`<indexName>-current`). Exposed for tests / admin UI. */
  readonly aliasName: string;
  /** OpenSearch node URI parsed out of `config.url`. */
  readonly node: string;
  /** Base index name (without timestamp / `-current` suffix). */
  readonly baseIndexName: string;
  /** Test-only handle to the underlying client. */
  readonly client: Client;
}

/**
 * Mutable driver state. `createOpenSearchDriver` receives a ref to
 * this; each driver method snapshots the fields it needs *once at the
 * top* of the call, so a concurrent `reconfigure` cannot swap the
 * client / index name mid-operation. `reconfigure` mutates the fields
 * in place via {@link applyConfigInPlace}; the next call sees the new
 * values. An empty `url` leaves `client` as `null` — the methods then
 * throw a `Search not configured` error rather than touching a stale
 * client.
 */
export interface OSDriverState {
  /** `null` when `url` is empty (driver configured-but-disabled). */
  client: Client | null;
  /** OpenSearch node URI parsed out of `config.url`; empty string when `url` is empty. */
  node: string;
  /** Base index name (without timestamp / `-current` suffix). */
  baseIndexName: string;
  /** Runtime alias the driver reads / writes (`<baseIndexName>-current`). */
  aliasName: string;
  analyzer: Analyzer;
  requestTimeout: number;
}

/**
 * Build a fresh {@link OSDriverState} from a config. An empty `url`
 * yields a disabled state (`client: null`) instead of throwing — the
 * driver stays registered but every method rejects with a
 * `Search not configured` error.
 */
export function applyConfig(config: OpenSearchDriverConfig): OSDriverState {
  if (!config.url) {
    return {
      client: null,
      node: '',
      baseIndexName: config.indexName,
      aliasName: `${config.indexName}-current`,
      analyzer: config.analyzer,
      requestTimeout: config.requestTimeout,
    };
  }
  const { node, indexName } = parseUri(config.url);
  const clientOpts: ClientOptions = {
    node,
    requestTimeout: config.requestTimeout,
  };
  return {
    client: new Client(clientOpts),
    node,
    baseIndexName: indexName,
    aliasName: `${indexName}-current`,
    analyzer: config.analyzer,
    requestTimeout: config.requestTimeout,
  };
}

/**
 * Mutate `target` in place to reflect `config`. Used by `reconfigure`:
 * the old client reference is returned so the caller can `close()` it
 * (fire-and-forget) once the swap is done — inflight operations have
 * already snapshotted the old client and will run to completion.
 */
export function applyConfigInPlace(target: OSDriverState, config: OpenSearchDriverConfig): { oldClient: Client | null } {
  const oldClient = target.client;
  // Assign over the freshly-built state so a new OSDriverState field
  // propagates through reconfigure automatically — no manual field
  // list here to fall out of sync with applyConfig.
  Object.assign(target, applyConfig(config));
  return { oldClient };
}

/** TTL for the cached user count used by the bookmark-count function-score factor. */
const USER_COUNT_TTL_MS = 5 * 60 * 1000;

/**
 * Build the search driver around an {@link OSDriverState} ref. Methods
 * snapshot `state` *once at the top* — a `reconfigure` running
 * concurrently with an inflight call cannot swap the client mid-call;
 * the next call sees the new client / index name.
 */
export function createOpenSearchDriver(state: OSDriverState, deps: OpenSearchDriverDeps = {}): OpenSearchDriver {
  const log = deps.log;

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

  const driver: OpenSearchDriver = {
    // Getters off the state ref: `reconfigure` makes these mutable, so
    // they must always reflect the *current* state, not a boot-time
    // literal. Tests read `driver.client` to install fakes — since the
    // getter returns the same object reference, mutating its methods
    // still works.
    get aliasName() {
      return state.aliasName;
    },
    get node() {
      return state.node;
    },
    get baseIndexName() {
      return state.baseIndexName;
    },
    get client() {
      return requireClient(state.client);
    },

    async index(doc: SearchableDoc): Promise<void> {
      const { client, aliasName } = snapshot(state);
      const source = docToEsSource(doc);
      await client.index({
        index: aliasName,
        id: doc.id,
        body: source as unknown as Record<string, unknown>,
      });
    },

    async remove(id: string): Promise<void> {
      const { client, aliasName } = snapshot(state);
      try {
        await client.delete({ index: aliasName, id });
      } catch (err) {
        // Idempotent: a missing doc is fine. The OpenSearch client
        // throws a `ResponseError` with statusCode 404 when the id
        // doesn't exist; swallow only that case.
        if (isNotFoundError(err)) return;
        throw err;
      }
    },

    async query(q: SearchQuery): Promise<SearchHits> {
      const { client, aliasName } = snapshot(state);
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

      // OpenSearch 3.x SDK takes the request body under the `body` key
      // (unlike ES 9 which inlines the body fields). The SDK's TS types
      // for `body` are very loose, so cast through `unknown`.
      const response = await client.search({
        index: aliasName,
        body: body as unknown as Record<string, unknown>,
      } as unknown as Parameters<Client['search']>[0]);

      const payload = (response.body ?? {}) as unknown as OsSearchResponseBody;
      const totalRaw = payload.hits?.total;
      const total = typeof totalRaw === 'number' ? totalRaw : (totalRaw?.value ?? 0);

      const rawHits = (payload.hits?.hits ?? []) as unknown as OsHit[];
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
      // Snapshot up front: a `reconfigure` mid-rebuild must not retarget
      // a long-running rebuild onto a different cluster / index name —
      // it runs to completion against the cluster it started on.
      const { client, aliasName, baseIndexName, analyzer } = snapshot(state);
      if (!deps.iteratePages || !deps.countAllPages || !deps.getBookmarkCountsBulk) {
        throw new Error('@crowi/plugin-search-opensearch: rebuild() requires iteratePages / countAllPages / getBookmarkCountsBulk deps.');
      }

      const newIndexName = createTimestampedIndexName(baseIndexName);
      log?.info('rebuild: creating index %s', newIndexName);

      const mapping = loadMapping(analyzer);
      await client.indices.create({ index: newIndexName, body: mapping as unknown as Record<string, unknown> });

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
      await deleteOldIndices(client, baseIndexName, newIndexName);
    },
  };

  return driver;
}

/**
 * Thrown by every driver method when `url` is empty (the driver is
 * registered-but-disabled). Surfaces to the search route as a clear
 * "configure OpenSearch" error rather than a `TypeError` on `null`.
 */
const SEARCH_NOT_CONFIGURED = '@crowi/plugin-search-opensearch: Search not configured (OpenSearch url is empty).';

function requireClient(client: Client | null): Client {
  if (!client) {
    throw new Error(SEARCH_NOT_CONFIGURED);
  }
  return client;
}

/**
 * One-line snapshot taken at the top of every driver method. Reading
 * `state` exactly once per call is what makes a concurrent
 * `reconfigure` race-safe.
 */
function snapshot(state: OSDriverState): { client: Client; aliasName: string; baseIndexName: string; analyzer: Analyzer } {
  return {
    client: requireClient(state.client),
    aliasName: state.aliasName,
    baseIndexName: state.baseIndexName,
    analyzer: state.analyzer,
  };
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
 * A Bonsai-style URL follows the format
 * `https://{ID}:{PASSWORD}@{HOST}[/{indexName}]`. Returns the node
 * URL for the SDK and the base index name.
 */
export function parseUri(uri: string): { node: string; indexName: string } {
  if (!uri.startsWith('http')) {
    throw new Error('URL for OpenSearch should starts with http/https');
  }

  const osUrl = new URL(uri);
  const auth = osUrl.username && osUrl.password ? `${osUrl.username}:${osUrl.password}@` : '';
  const node = `${osUrl.protocol}//${auth}${osUrl.host}`;
  const indexName = osUrl.pathname && osUrl.pathname !== '/' ? osUrl.pathname.substring(1) : 'crowi';

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
 * is a small deep-merge of plain JSON objects — adequate for the
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
  iteratePages: NonNullable<OpenSearchDriverDeps['iteratePages']>;
  countAllPages: NonNullable<OpenSearchDriverDeps['countAllPages']>;
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
      // OpenSearch 3.x SDK: bulk operations go under `body`, not
      // `operations`. The response is `{ body: { errors, took, items, ... } }`.
      const response = await ctx.client.bulk({
        body: operations,
        timeout: '1d',
      });
      const payload = (response.body ?? {}) as { errors?: boolean; took?: number };
      if (payload.errors) {
        ctx.log?.warn('rebuild: bulk had item-level errors (took=%dms)', payload.took);
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

export function shouldIndex(doc: PageStreamDoc): boolean {
  if (doc.redirectTo !== null && doc.redirectTo !== undefined) return false;
  if (doc.status === 'deleted') return false;
  // Drafts must never be indexed: the search route has no per-viewer
  // draft-author filter, so an indexed draft would leak its path/existence
  // to other users. Pages are (re)indexed on the update event at publish.
  if (doc.status === 'draft') return false;
  // feature-restricted-grant-share-banner — wip / deprecated are excluded
  // from the index too, matching list's visibility boundary
  // (`visiblePageStatusOr` in `@crowi/api`). Without this, these pages
  // would sit in the index as permanent dead hits once the search
  // hydration's status drop lands (they're always returned by the driver,
  // then always dropped, wasting a result slot every time).
  if (doc.status === 'wip' || doc.status === 'deprecated') return false;
  return true;
}

async function switchAlias(client: Client, aliasName: string, newIndex: string): Promise<void> {
  const aliasInfo = await getCurrentAliasInfo(client, aliasName);

  const actions: Record<string, unknown>[] = [{ add: { index: newIndex, alias: aliasName } }];
  if (aliasInfo) {
    // Remove the alias from whatever index it currently points to.
    actions.push({ remove: { index: aliasInfo.index, alias: aliasName } });
  }

  await client.indices.updateAliases({ body: { actions } });
}

async function getCurrentAliasInfo(client: Client, aliasName: string): Promise<{ alias: string; index: string } | null> {
  try {
    const exists = await client.indices.existsAlias({ name: aliasName });
    // SDK 3.x: existsAlias returns `{ body: boolean, statusCode, ... }`.
    // Treat anything that doesn't unwrap to `true` as "not present".
    if (!exists.body) return null;
  } catch {
    return null;
  }
  const aliases = await client.cat.aliases({ name: aliasName, format: 'json' });
  const list = (aliases.body ?? []) as unknown as Array<{ alias: string; index: string }>;
  return list.length > 0 ? { alias: list[0].alias, index: list[0].index } : null;
}

async function deleteOldIndices(client: Client, baseIndexName: string, keepIndexName: string): Promise<void> {
  // Server-side prefix filter so we don't pull every index in the
  // cluster — a Crowi cluster can be shared with other apps.
  const indices = await client.cat.indices({ index: `${baseIndexName}-*`, format: 'json' });
  const list = (indices.body ?? []) as unknown as Array<{ index: string }>;
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
 * Single source of truth for the search-doc field names. We keep the
 * `ES_FIELDS` identifier verbatim from the ES plugin: these field
 * names go on the wire to OpenSearch but they are also identical to
 * what the ES plugin writes, by design — a re-point + rebuild between
 * the two backends needs no mapping rewrite. Renaming the constant
 * would obscure that invariant.
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

interface OsPageSource {
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
 * SearchableDoc -> OpenSearch page source. Plugin-API only mandates
 * id / path / body; everything else we look up in `meta.*` for the
 * keys the legacy indexer produced. Unknown / missing keys are simply
 * omitted (mapping is non-strict, so OpenSearch tolerates that).
 */
export function docToEsSource(doc: SearchableDoc): OsPageSource {
  const meta = (doc.meta ?? {}) as Record<string, unknown>;
  const source: OsPageSource = {
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
function pageStreamDocToEsSource(doc: PageStreamDoc, bookmarkCount: number): OsPageSource {
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

interface OsHit {
  _id: unknown;
  _score?: number;
  _source?: unknown;
  highlight?: Record<string, string[]>;
}

interface OsSearchResponseBody {
  hits?: {
    total?: number | { value: number };
    hits?: OsHit[];
  };
}

function pickSnippet(highlight: Record<string, string[]> | undefined): string | undefined {
  if (!highlight) return undefined;
  // Prefer Japanese body, then English body, then path. Pick the first
  // fragment for each — OpenSearch sorts within a field by score so
  // the first is the most relevant.
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
