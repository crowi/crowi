/**
 * Build an Elasticsearch 8 search request body from the SearchQuery
 * shape exposed by `@crowi/plugin-api`. The driver passes a parsed
 * keyword/phrase tree plus the viewer + grants from the original
 * SearchQuery; this module composes them into a single bool query.
 *
 * Design notes:
 *   - All filters are composed at the top-level `bool`. We never nest
 *     a second `bool` for the same operator type (must / filter /
 *     should / must_not), so the generated body is small and easy to
 *     diff in tests.
 *   - The grant filter mirrors the legacy ES Searcher precisely:
 *     a non-public page (RESTRICTED / SPECIFIED / OWNER) is hidden
 *     unless its `username` field matches the viewer's username.
 *     For SPECIFIED / OWNER / RESTRICTED pages, we additionally allow
 *     the page through if `granted_users` contains the viewer id —
 *     the legacy query only checked `username`, but the new
 *     SearchableDoc lets us index `granted_users` precisely so we
 *     can express "shared with me" as well.
 *   - Type filter (portal / public / user) reproduces the legacy
 *     `path.raw` regex / prefix queries.
 */

import type { SearchPageType, SearchQueryGrants, SearchQueryViewer } from '@crowi/plugin-api';
import type { ParsedSearchQuery } from './parse-query';

// Page grant constants — mirror `apps/crowi-api/src/models/page.ts`.
// Hard-coded here because the plugin must not import from @crowi/api
// (that would invert the dependency direction and force a runner
// rebuild on every plugin change).
export const GRANT_PUBLIC = 1;
export const GRANT_RESTRICTED = 2;
export const GRANT_SPECIFIED = 3;
export const GRANT_OWNER = 4;

// TODO: By user's i18n setting, change boost or search target fields.
export const defaultKeywordQueryFields = ['path.ja^2', 'body.ja', 'path.en^1.2', 'body.en'];
// Not use "*.ja" fields here because we want to analyse (parse) phrase
// search words.
export const defaultPhraseQueryFields = ['path.raw^2', 'body'];

const portalQuery = { regexp: { 'path.raw': '.*/' } };
const userPathQuery = { prefix: { 'path.raw': '/user/' } };

export type FunctionScoreParams = {
  fieldValueFactor: {
    field: string;
    factor?: number;
    modifier?: 'log' | 'log1p' | 'log2p' | 'ln' | 'ln1p' | 'ln2p' | 'square' | 'sqrt' | 'reciprocal' | 'none';
    missing: number;
  };
  boostMode: 'multiply' | 'replace' | 'sum' | 'avg' | 'max' | 'min';
};

export interface BuildSearchBodyParams {
  parsed: ParsedSearchQuery;
  pathPrefix?: string;
  viewer?: SearchQueryViewer;
  grants?: SearchQueryGrants;
  functionScore?: FunctionScoreParams;
  from: number;
  size: number;
}

// Loose typing: ES8 SDK accepts plain JSON for the request body, so we
// keep this internal type representation close to the wire format.
// Using `unknown` keeps the shape opaque; tests rely on snapshot
// equality rather than structural typing.
type EsQueryBody = Record<string, unknown>;

interface BoolBuckets {
  must: EsQueryBody[];
  filter: EsQueryBody[];
  should: EsQueryBody[];
  must_not: EsQueryBody[];
}

const emptyBuckets = (): BoolBuckets => ({ must: [], filter: [], should: [], must_not: [] });

const appendKeywords = (buckets: BoolBuckets, keywords: string[], operator: 'and' | 'or', kind: 'must' | 'must_not'): void => {
  if (keywords.length === 0) return;
  buckets[kind].push({
    multi_match: {
      query: keywords.join(' '),
      fields: defaultKeywordQueryFields,
      operator,
    },
  });
};

const appendPhrases = (buckets: BoolBuckets, phrases: string[], operator: 'and' | 'or', kind: 'must' | 'must_not'): void => {
  for (const phrase of phrases) {
    buckets[kind].push({
      multi_match: {
        type: 'phrase',
        query: phrase,
        fields: defaultPhraseQueryFields,
        operator,
      },
    });
  }
};

const appendTypeFilter = (buckets: BoolBuckets, type: SearchPageType): void => {
  switch (type) {
    case 'portal':
      buckets.must_not.push(userPathQuery);
      buckets.filter.push(portalQuery);
      return;
    case 'public':
      buckets.must_not.push(userPathQuery);
      buckets.must_not.push(portalQuery);
      return;
    case 'user':
      buckets.filter.push(userPathQuery);
      return;
  }
};

const appendPathPrefix = (buckets: BoolBuckets, pathPrefix: string): void => {
  const trimmed = pathPrefix.endsWith('/') ? pathPrefix.slice(0, -1) : pathPrefix;
  buckets.filter.push({
    wildcard: {
      'path.raw': `${trimmed}/*`,
    },
  });
};

const appendGrantFilter = (buckets: BoolBuckets, viewer?: SearchQueryViewer): void => {
  if (!viewer) {
    // Anonymous viewer: only public pages.
    buckets.filter.push({ match: { grant: GRANT_PUBLIC } });
    return;
  }
  if (viewer.isAdmin) {
    // Admins see everything; no grant filter.
    return;
  }

  // Non-admin authenticated viewer: a page is visible iff
  //   grant === GRANT_PUBLIC, OR
  //   page.username === viewer.username (legacy semantics — the
  //     creator can always find their own restricted/owner pages), OR
  //   page.granted_users contains viewer.id (specified/restricted
  //     share targets).
  buckets.filter.push({
    bool: {
      should: [{ term: { grant: GRANT_PUBLIC } }, { term: { username: viewer.username } }, { term: { granted_users: viewer.id } }],
      minimum_should_match: 1,
    },
  });
};

/**
 * Build the ES8 search request body. Returns an object suitable for
 * `client.search({ index, ...body })`.
 */
export function buildSearchBody(params: BuildSearchBodyParams): {
  from: number;
  size: number;
  sort: Array<Record<string, unknown>>;
  highlight: Record<string, unknown>;
  query: Record<string, unknown>;
  _source: string[];
} {
  const { parsed, pathPrefix, viewer, grants, functionScore, from, size } = params;
  const buckets = emptyBuckets();

  appendKeywords(buckets, parsed.keywords.positive, 'and', 'must');
  appendKeywords(buckets, parsed.keywords.negative, 'or', 'must_not');
  appendPhrases(buckets, parsed.phrases.positive, 'and', 'must');
  appendPhrases(buckets, parsed.phrases.negative, 'or', 'must_not');

  if (pathPrefix) {
    appendPathPrefix(buckets, pathPrefix);
  }

  if (grants?.types && grants.types.length > 0) {
    // Multiple types are OR-combined as separate `should` clauses.
    if (grants.types.length === 1) {
      appendTypeFilter(buckets, grants.types[0]);
    } else {
      const typeShoulds: EsQueryBody[] = grants.types.map((t) => {
        const inner = emptyBuckets();
        appendTypeFilter(inner, t);
        return { bool: pruneBool(inner) };
      });
      buckets.filter.push({
        bool: { should: typeShoulds, minimum_should_match: 1 },
      });
    }
  }

  appendGrantFilter(buckets, viewer);

  const baseQuery: Record<string, unknown> = { bool: pruneBool(buckets) };

  const query = functionScore
    ? {
        function_score: {
          query: baseQuery,
          field_value_factor: functionScore.fieldValueFactor,
          boost_mode: functionScore.boostMode,
        },
      }
    : baseQuery;

  return {
    from,
    size,
    sort: [{ _score: 'desc' }],
    highlight: {
      pre_tags: ['<mark>'],
      post_tags: ['</mark>'],
      fields: {
        'path.ja': {},
        'body.ja': {},
        body: {},
      },
    },
    query,
    _source: ['path', 'bookmark_count', 'username', 'grant'],
  };
}

/**
 * Strip empty arrays so the wire body stays compact. ES accepts an
 * empty bool clause but it pollutes snapshots.
 */
function pruneBool(buckets: BoolBuckets): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (buckets.must.length > 0) out.must = buckets.must;
  if (buckets.filter.length > 0) out.filter = buckets.filter;
  if (buckets.should.length > 0) out.should = buckets.should;
  if (buckets.must_not.length > 0) out.must_not = buckets.must_not;
  return out;
}
