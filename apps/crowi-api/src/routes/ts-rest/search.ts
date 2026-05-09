import { createExpressEndpoints, initServer } from '@ts-rest/express';
import { apiContract, type SearchHit as SearchHitResponse } from '@crowi/api-contract';
import type { SearchHits, SearchQuery } from '@crowi/plugin-api';
import Crowi from 'src/crowi';
import { Express, Router } from 'express';
import { Types } from 'mongoose';
import { UserDocument } from 'src/models/user';
import { PageDocument } from 'src/models/page';
import { internalServerErrorResponse } from 'src/util/ts-rest-helpers';
import { pageToResponse } from 'src/util/page-response';
import Debug from 'debug';

const debug = Debug('crowi:routes:ts-rest:search');

export default (crowi: Crowi, _app: Express) => {
  const s = initServer();
  const router = Router();
  const Page = crowi.model('Page');
  const Bookmark = crowi.model('Bookmark');

  const searchRouter = s.router(apiContract.search, {
    searchPages: async ({ query, req }) => {
      const user = req.user as UserDocument;
      const { q, tree, type, page, limit } = query;

      debug('searchPages called with:', { q, tree, type, page, limit, userId: user._id });

      const search = crowi.getSearcher();
      if (!search) {
        return {
          status: 503,
          body: {
            error: {
              code: 'SERVICE_UNAVAILABLE' as const,
              feature: 'search',
              message: 'No search driver registered. Install a @crowi/plugin-search-* package in the runner project to enable search.',
            },
          },
        };
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
          return {
            status: 200,
            body: {
              meta: {
                ...(took !== undefined ? { took } : {}),
                total,
                results: 0,
              },
              data: [],
            },
          };
        }

        const objectIds = hits.map((hit) => new Types.ObjectId(hit.id));

        // Run the two Mongo joins in parallel: Page populate (creator +
        // revision.author) and bulk bookmark counts. Both are bounded by
        // `limit` (max 100) so the parallel work is small.
        const [pages, bookmarkCounts] = await Promise.all([
          Page.findListByPageIds(objectIds, { limit: hits.length }) as Promise<PageDocument[]>,
          Bookmark.getCountsByPageIds(objectIds),
        ]);

        const pageById = new Map<string, PageDocument>();
        for (const p of pages) {
          pageById.set(p._id.toString(), p);
        }

        const data: SearchHitResponse[] = [];
        for (const hit of hits) {
          const populated = pageById.get(hit.id);
          // Drop hits whose Page document is missing (e.g. concurrently
          // deleted between the index hit and the populate query). The
          // driver should also have filtered by grant, but a stale
          // index can outrun the filter — keeping `data` consistent
          // with `meta.results` lets clients trust the count.
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

        return {
          status: 200,
          body: {
            meta: {
              ...(took !== undefined ? { took } : {}),
              total,
              results: data.length,
            },
            data,
          },
        };
      } catch (err) {
        const error = err as Error;
        debug('Search request failed:', error.message);
        return internalServerErrorResponse;
      }
    },
  });

  createExpressEndpoints(apiContract.search, searchRouter, router);

  return router;
};
