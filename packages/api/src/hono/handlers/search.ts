/**
 * RFC-0006 Phase 4 Batch 7 — `search` resource Hono port.
 *
 * Replaces `packages/api/src/routes/ts-rest/search.ts`. Single endpoint:
 *
 *   GET /search — full-text search over indexed pages
 *
 * Auth:
 *   - `/search` is a singleton literal path OUTSIDE the revision-owned
 *     `/pages/*` jwtAuth apply. This handler installs
 *     `createJwtAuth(crowi)` on the path itself — same single-route
 *     install pattern as `autocomplete`'s `/users/autocomplete`.
 *   - No other handler owns `/search`, so there is no risk of double-apply.
 *
 * Rate limiting:
 *   - None. The legacy `/api/v2/search` had no `withRateLimit` wrapping —
 *     driver latency (Elasticsearch / Mongo regex) naturally throttles
 *     bursts and the RFC does not require an explicit budget here.
 *
 * Search backend availability:
 *   - `crowi.getSearcher()` returns `null` when no `@crowi/plugin-search-*`
 *     is installed in the runner project. The handler returns 503
 *     `SERVICE_UNAVAILABLE` with `feature: 'search'` so callers can
 *     branch on the missing-subsystem case. The body is byte-identical
 *     with the ts-rest era (literal message preserved).
 *
 * The `data[].snippet` field carries the driver-supplied highlight string
 * verbatim (typically with `<mark>` tokens). The handler does NOT escape
 * it; the web client is responsible for sanitising before HTML render.
 *
 * Authorization (SEC-SEARCH-DELEGATED defense-in-depth):
 *   - The active `SearchDriver` is expected to filter hits by grant, but
 *     that check is fully delegated to a pluggable (possibly
 *     third-party) implementation. This handler does not trust it
 *     blindly: `Page.findListByPageIds` is called with the requesting
 *     `user._id` as viewer, which re-applies `visiblePageGrantOr` at the
 *     Mongo query level, so any hit the viewer isn't authorized to read
 *     is dropped before it reaches `data[]`.
 */
import { searchPagesRoute, type SearchHit as SearchHitResponse } from '@crowi/api-contract';
import type { OpenAPIHono } from '@hono/zod-openapi';
import Debug from 'debug';
import { Types } from 'mongoose';

import type Crowi from 'src/crowi';
import type { PageDocument } from 'src/models/page';
import type { SearchHits, SearchQuery } from '@crowi/plugin-api';
import { pageToResponse } from 'src/util/page-response';

import type { CrowiHonoBindings } from '../app';
import { createJwtAuth } from '../middleware/auth';
import { applyScope } from '../middleware/require-scope';
import { INTERNAL_ERROR_BODY } from './_helpers/errors';

const debug = Debug('crowi:hono:handlers:search');

/**
 * 503 envelope returned when `crowi.getSearcher()` is `null`. Message
 * literal preserved verbatim from the ts-rest era so any client
 * pattern-matching on it (we know of none, but the legacy parity
 * promise covers it) keeps working.
 */
const SEARCH_UNAVAILABLE_BODY = {
  error: {
    code: 'SERVICE_UNAVAILABLE' as const,
    feature: 'search',
    message: 'No search driver registered. Install a @crowi/plugin-search-* package in the runner project to enable search.',
  },
};

export const registerSearchRoutes = <E extends OpenAPIHono<CrowiHonoBindings>>(app: E, crowi: Crowi) => {
  const Page = crowi.model('Page');
  const Bookmark = crowi.model('Bookmark');

  // `/search` is OUTSIDE the revision-owned `/pages/*` apply — install
  // jwtAuth on the singleton path here. No other handler owns
  // `/search`, so this is a single-route install with no double-apply
  // risk.
  app.use('/search', createJwtAuth(crowi));

  // RFC-0010 — search is a page read.
  applyScope(app, searchPagesRoute, 'pages:read');

  return app.openapi(searchPagesRoute, async (c) => {
    const user = c.get('user');
    const { q, tree, type, page, limit } = c.req.valid('query');

    debug('searchPages called with:', { q, tree, type, page, limit, userId: user._id.toString() });

    const search = crowi.getSearcher();
    if (!search) {
      return c.json(SEARCH_UNAVAILABLE_BODY, 503);
    }

    const searchQuery: SearchQuery = {
      q,
      page,
      limit,
      ...(tree ? { pathPrefix: tree } : {}),
      viewer: {
        id: user._id.toString(),
        username: user.username,
        isAdmin: user.admin === true,
      },
      ...(type ? { grants: { types: [type] } } : {}),
    };

    try {
      const driverResult: SearchHits = await search.query(searchQuery);
      const { total, hits, took } = driverResult;

      // Fast path: nothing to populate. Skipping the Mongo round-trip
      // matters for "no hits" queries which are the common case for
      // typo'd / mid-typing search input.
      if (hits.length === 0) {
        return c.json(
          {
            meta: {
              ...(took !== undefined ? { took } : {}),
              total,
              results: 0,
            },
            data: [],
          },
          200,
        );
      }

      const objectIds = hits.map((hit) => new Types.ObjectId(hit.id));

      // Run the two Mongo joins in parallel: Page populate (creator +
      // revision.author) and bulk bookmark counts. Both are bounded by
      // `limit` (max 100) so the parallel work is small.
      //
      // `findListByPageIds` is given `user._id` as the viewer so it
      // re-applies `visiblePageGrantOr` (SEC-SEARCH-DELEGATED
      // defense-in-depth): the driver should already have filtered by
      // grant, but a stale index or a third-party driver's filtering bug
      // can outrun it — the API boundary re-checks rather than trusting
      // the driver's hits unconditionally.
      const [pages, bookmarkCounts] = await Promise.all([
        Page.findListByPageIds(objectIds, { limit: hits.length }, user._id) as Promise<PageDocument[]>,
        Bookmark.getCountsByPageIds(objectIds),
      ]);

      const pageById = new Map<string, PageDocument>();
      for (const p of pages) {
        pageById.set(p._id.toString(), p);
      }

      const data: SearchHitResponse[] = [];
      for (const hit of hits) {
        const populated = pageById.get(hit.id);
        // Drop hits whose Page document didn't come back from
        // `findListByPageIds` — either it no longer exists (e.g.
        // concurrently deleted between the index hit and the populate
        // query) or the viewer isn't authorized to see it (grant
        // re-filter above). Both cases fall through the same `pageById`
        // lookup, keeping `data` consistent with `meta.results`.
        if (!populated) continue;
        data.push({
          pageId: hit.id,
          path: hit.path,
          score: hit.score,
          snippet: hit.snippet,
          bookmarkCount: bookmarkCounts.get(hit.id) ?? 0,
          page: pageToResponse(populated),
        });
      }

      // Subtract the hits we dropped (not-granted / no backing doc) from
      // the driver's raw total (CROWI-SEC-REVIEW-003): reporting the raw
      // total alongside a filtered `data` is a private-page existence
      // oracle — `data: []` with `total: 1` tells an ungranted caller
      // that a private page matching their query exists. Per-page
      // subtraction kills that crisp oracle; an exact authorized total
      // across all result pages needs the grant predicate pushed into
      // the driver query itself (tracked by
      // feature-central-page-authorization's query-level-grant retrofit).
      const dropped = hits.length - data.length;
      return c.json(
        {
          meta: {
            ...(took !== undefined ? { took } : {}),
            total: Math.max(0, total - dropped),
            results: data.length,
          },
          data,
        },
        200,
      );
    } catch (err) {
      const error = err as Error;
      debug('Search request failed:', error.message);
      return c.json(INTERNAL_ERROR_BODY, 500);
    }
  });
};
