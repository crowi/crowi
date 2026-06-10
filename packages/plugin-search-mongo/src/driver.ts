/**
 * `createMongoSearchDriver` — the `'mongo'` SearchDriver. It searches live
 * data (`Page` + the page's current `Revision`) with a case-insensitive
 * `$regex`, so there is NO separate search index to maintain:
 *
 *   - `index()` / `remove()` are no-ops. The page body already lives in
 *     Page / Revision, so the page-saved event hook has nothing extra to
 *     persist. They never throw, so wiring the driver into the save path
 *     can never fail a page write.
 *   - `rebuild()` is omitted (there is no index to rebuild).
 *   - `query()` runs the actual search.
 *
 * Body-fetch strategy (spec open question 2):
 *   A two-pass approach keyed off the path/title pass, chosen over a single
 *   `$lookup` aggregation for readability on the slim / small-deployment
 *   target this driver serves:
 *     1. PATH pass — pages whose `path` matches the keyword. These are the
 *        strongest hits (the page title is its path) and are returned first.
 *     2. BODY pass — among the viewer-visible candidate pages (capped at
 *        CANDIDATE_CAP to bound the non-anchored `$regex` collection scan),
 *        look up their current revisions whose `body` matches the keyword in
 *        one bulk `Revision.find({ revision: { $in }, body: regex })`, then
 *        map the matched revisions back to their pages.
 *   The two result sets are merged (path hits first, body-only hits after),
 *   de-duplicated by page id, then paged with skip/limit. `total` is the
 *   size of the merged set (capped by CANDIDATE_CAP on the body side).
 *
 * Ranking / score (spec open questions 3 & 4): a simple 2-value score —
 * path/title hits score 2, body-only hits score 1 — expressed by ordering
 * path hits ahead of body hits. No function score / field boosting.
 *
 * Snippet (spec open question 3): best-effort substring around the first
 * match, with the matched span wrapped in `<mark>`. NOT HTML-escaped — the
 * search route passes snippets through verbatim and the web client
 * sanitises before render (same contract as the ES driver's highlight).
 */

import type { PluginContext, SearchableDoc, SearchDriver, SearchHit, SearchHits, SearchQuery } from '@crowi/plugin-api';

import { buildPageFilter, clampLimit, keywordRegex, pageToSkip } from './query-builder';

/**
 * Upper bound on candidate pages scanned by the body pass. A non-anchored
 * `$regex` cannot use an index, so we bound the scan: beyond this many
 * visible candidates the body pass is truncated and path/title hits are
 * preferred. Generous for the small / mid deployments this driver targets;
 * larger installs should run the Elasticsearch driver.
 */
export const CANDIDATE_CAP = 5000;

/** Characters of context to include on each side of a snippet match. */
const SNIPPET_RADIUS = 60;

interface PageDoc {
  _id: { toString(): string };
  path: string;
  revision?: { toString(): string } | null;
}

/**
 * Minimal Mongoose model surface the driver touches. `ctx.model()` returns
 * `unknown`; we narrow to just the query methods we call.
 */
interface PageModelLike {
  find(filter: Record<string, unknown>): {
    select(projection: string): {
      limit(n: number): {
        lean(): { exec(): Promise<PageDoc[]> };
      };
    };
  };
}

interface RevisionModelLike {
  find(filter: Record<string, unknown>): {
    select(projection: string): {
      lean(): { exec(): Promise<Array<{ _id: { toString(): string }; body: string }>> };
    };
  };
}

/**
 * Build a best-effort snippet: a window around the first case-insensitive
 * match of `keyword` in `text`, with the match wrapped in `<mark>`.
 * Returns undefined when the text has no match (e.g. a path-only hit).
 */
export function buildSnippet(text: string, keyword: RegExp): string | undefined {
  const match = keyword.exec(text);
  if (!match) return undefined;
  const start = Math.max(0, match.index - SNIPPET_RADIUS);
  const end = Math.min(text.length, match.index + match[0].length + SNIPPET_RADIUS);
  const before = text.slice(start, match.index);
  const hit = text.slice(match.index, match.index + match[0].length);
  const after = text.slice(match.index + match[0].length, end);
  const prefix = start > 0 ? '…' : '';
  const suffix = end < text.length ? '…' : '';
  return `${prefix}${before}<mark>${hit}</mark>${after}${suffix}`;
}

export function createMongoSearchDriver(ctx: PluginContext): SearchDriver {
  const Page = ctx.model('Page') as PageModelLike;
  const Revision = ctx.model('Revision') as RevisionModelLike;

  return {
    // Live-regex driver: nothing to index. Kept as resolved no-ops so the
    // page-saved hook can call them unconditionally without error.
    async index(_doc: SearchableDoc): Promise<void> {
      // no-op
    },
    async remove(_id: string): Promise<void> {
      // no-op
    },

    async query(q: SearchQuery): Promise<SearchHits> {
      const startedAt = Date.now();
      const keyword = keywordRegex(q.q);
      const limit = clampLimit(q.limit);
      const skip = pageToSkip(q.page, limit);

      // Empty / whitespace-only query: no hits (avoid a full scan).
      if (!keyword) {
        return { total: 0, hits: [], took: Date.now() - startedAt };
      }

      const type = q.grants?.types && q.grants.types.length > 0 ? q.grants.types[0] : undefined;
      const scope = { keyword, viewer: q.viewer, type, pathPrefix: q.pathPrefix } as const;
      const revIdOf = (page: PageDoc): string | null => (page.revision ? page.revision.toString() : null);

      // PATH pass (pages whose path matches the keyword) and BODY candidate
      // pass (viewer-visible pages whose revision we will match) are
      // independent Mongo reads — run them together.
      const [pathPages, candidatePages] = await Promise.all([
        Page.find(buildPageFilter({ ...scope, matchPath: true }))
          .select('_id path revision')
          .limit(CANDIDATE_CAP)
          .lean()
          .exec(),
        Page.find(buildPageFilter({ ...scope, matchPath: false }))
          .select('_id path revision')
          .limit(CANDIDATE_CAP)
          .lean()
          .exec(),
      ]);

      const pathHitIds = new Set(pathPages.map((p) => p._id.toString()));

      // Map currentRevision -> page, skipping pages already matched by path
      // (those are stronger hits) and pages with no revision pointer.
      const revisionToPage = new Map<string, PageDoc>();
      for (const page of candidatePages) {
        if (pathHitIds.has(page._id.toString())) continue;
        const revId = revIdOf(page);
        if (revId) revisionToPage.set(revId, page);
      }

      // Bulk body match. Keep the matched bodies so the snippet pass can use
      // them directly instead of re-fetching the same revisions.
      const bodyHits: PageDoc[] = [];
      const bodyById = new Map<string, string>();
      if (revisionToPage.size > 0) {
        const revisions = await Revision.find({ _id: { $in: Array.from(revisionToPage.keys()) }, body: { $regex: keyword } })
          .select('_id body')
          .lean()
          .exec();
        for (const rev of revisions) {
          const page = revisionToPage.get(rev._id.toString());
          if (page) {
            bodyHits.push(page);
            bodyById.set(rev._id.toString(), rev.body);
          }
        }
      }

      // Merge: path hits (score 2) first, body-only hits (score 1) after.
      const merged: Array<{ page: PageDoc; score: number }> = [
        ...pathPages.map((page) => ({ page, score: 2 })),
        ...bodyHits.map((page) => ({ page, score: 1 })),
      ];

      const total = merged.length;
      const windowed = merged.slice(skip, skip + limit);

      const hits: SearchHit[] = windowed.map(({ page, score }) => {
        const revId = revIdOf(page);
        // Path hits always snippet off the path (the match is in the title);
        // body-only hits read from the body captured by the body pass.
        const body = revId ? bodyById.get(revId) : undefined;
        // Prefer a path snippet (the match is in the title); fall back to
        // the body for body-only hits.
        const snippet = buildSnippet(page.path, keyword) ?? (body ? buildSnippet(body, keyword) : undefined);
        return {
          id: page._id.toString(),
          path: page.path,
          score,
          ...(snippet ? { snippet } : {}),
        };
      });

      return { total, hits, took: Date.now() - startedAt };
    },

    // rebuild intentionally omitted — there is no persistent index.
  };
}
