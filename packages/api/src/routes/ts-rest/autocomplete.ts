import { createExpressEndpoints, initServer } from '@ts-rest/express';
import { apiContract } from '@crowi/api-contract';
import type { AutocompleteResult } from '@crowi/api-contract';
import Crowi from 'src/crowi';
import { Express, Router } from 'express';
import type { UserDocument } from 'src/models/user';
import { visiblePageGrantOr, visiblePageStatusOr } from 'src/models/page';
import { scoreCandidate } from 'src/util/autocomplete-match';
import { createRateLimiter } from 'src/util/rate-limit';
import { escapeRegExp } from 'src/util/regex';
import { toISOStringOrNull } from 'src/util/ts-rest-helpers';
import type { Response } from 'express';
import Debug from 'debug';

const debug = Debug('crowi:routes:ts-rest:autocomplete');

/** Per-user budget for the autocomplete endpoints — RFC §"Rate limit". */
const RATE_LIMIT = 60;
const RATE_WINDOW_MS = 60_000;

/** Last `/`-separated segment of a wiki path — the page's "title". */
const pathLeaf = (path: string): string => {
  const trimmed = path.replace(/\/+$/, '');
  const idx = trimmed.lastIndexOf('/');
  return idx >= 0 ? trimmed.slice(idx + 1) : trimmed;
};

/**
 * RFC-0004 Phase 5 — autocomplete endpoints
 * (`GET /api/v2/users/autocomplete`, `GET /api/v2/pages/autocomplete`).
 *
 * Standalone router (mirrors `draft.ts`) mounted in the authenticated
 * router, so `jwtAuth` is already applied and `req.user` is a
 * `UserDocument`.
 *
 * Each request:
 *   1. Counts against a per-user 60 req/min budget. Over budget → 429
 *      with `Retry-After`; the editor closes the dropdown silently.
 *   2. Over-fetches a candidate set from Mongo with a case-insensitive
 *      substring filter (the widest filter an index serves cheaply).
 *   3. Ranks the candidates in-process — prefix > substring > fuzzy —
 *      via `scoreCandidate`, and returns the top `limit`.
 *
 * Permission filtering:
 *   - users: only `STATUS_ACTIVE` users are queried.
 *   - pages: the Mongo query carries a grant-aware `$or` so a caller
 *     only ever sees pages they can read; draft pages are excluded
 *     unless the caller is the draft's author.
 *
 * The rate limiter shares `crowi.redis` when present (so the budget is
 * enforced across api replicas) and falls back to an in-process
 * counter otherwise — see `util/rate-limit.ts`.
 */
export default (crowi: Crowi, _app: Express) => {
  const s = initServer();
  const router = Router();
  const User = crowi.model('User');
  const Page = crowi.model('Page');

  // One shared limiter per process. `crowi.redis` is `null` in
  // single-instance dev, which selects the in-memory fallback.
  const limiter = createRateLimiter({
    name: 'autocomplete',
    limit: RATE_LIMIT,
    windowMs: RATE_WINDOW_MS,
    redisClient: crowi.redis ?? null,
  });

  /**
   * Count a request and, if over budget, write the `Retry-After`
   * header and return the 429 body. Returns `null` when the request
   * is within budget and should proceed.
   */
  const enforceRateLimit = async (userId: string, res: Response) => {
    const result = await limiter.hit(userId);
    if (result.allowed) return null;
    res.setHeader('Retry-After', String(result.retryAfterSeconds));
    return {
      status: 429 as const,
      body: {
        error: 'rate_limited' as const,
        message: 'Autocomplete rate limit exceeded. Try again shortly.',
        retryAfterSeconds: result.retryAfterSeconds,
      },
    };
  };

  const autocompleteRouter = s.router(apiContract.autocomplete, {
    /**
     * GET /api/v2/users/autocomplete?q=<prefix>&limit=10
     *
     * Suggest active users for an `@<char>` mention. Matches across
     * `username` / display name / email-local-part, ranked
     * prefix > substring > fuzzy with `username` weighted highest.
     */
    autocompleteUsers: async ({ query, req, res }) => {
      const user = req.user as UserDocument;
      const limited = await enforceRateLimit(user._id.toString(), res);
      if (limited) return limited;

      const { q, limit } = query;
      debug('autocompleteUsers', { q, limit, userId: user._id.toString() });

      // Widest cheap filter: a case-insensitive substring match on any
      // of the three fields. Fuzzy hits that are *not* substrings are
      // intentionally not surfaced for users — username typo tolerance
      // is low-value and the substring net already covers prefixes.
      const re = new RegExp(escapeRegExp(q), 'i');
      const candidates = (await User.find({
        status: User.STATUS_ACTIVE,
        $or: [{ username: re }, { name: re }, { email: re }],
      })
        .select('_id username name email image')
        .limit(200)
        .lean()
        .exec()) as Array<{ _id: { toString(): string }; username?: string; name?: string; email?: string; image?: string | null }>;

      const results: AutocompleteResult[] = candidates
        .map((c) => {
          const username = c.username ?? '';
          const name = c.name ?? '';
          const emailLocal = (c.email ?? '').split('@')[0] ?? '';
          const score = scoreCandidate(
            [
              { text: username, weight: 30 },
              { text: name, weight: 20 },
              { text: emailLocal, weight: 10 },
            ],
            q,
          );
          return { c, username, name, score };
        })
        .filter((entry) => entry.score > 0)
        .sort((a, b) => b.score - a.score || a.username.localeCompare(b.username))
        .slice(0, limit)
        .map((entry) => ({
          id: entry.c._id.toString(),
          label: entry.username,
          display: entry.name ? `${entry.name} (@${entry.username})` : `@${entry.username}`,
          avatar: entry.c.image ?? null,
          score: entry.score,
        }));

      return { status: 200 as const, body: { results } };
    },

    /**
     * GET /api/v2/pages/autocomplete?q=<prefix>&limit=10
     *
     * Suggest readable pages for a `[[` wikilink. The Mongo query is
     * grant-aware (public / restricted-or-specified-to-me / owned-by-me)
     * and excludes other users' drafts; matching ranks the full `path`
     * highest and the path leaf second.
     */
    autocompletePages: async ({ query, req, res }) => {
      const user = req.user as UserDocument;
      const limited = await enforceRateLimit(user._id.toString(), res);
      if (limited) return limited;

      const { q, limit } = query;
      debug('autocompletePages', { q, limit, userId: user._id.toString() });

      const re = new RegExp(escapeRegExp(q), 'i');
      const candidates = (await Page.find({
        redirectTo: null,
        path: re,
        // Grant-aware read filter + draft visibility, both shared with
        // the page listing queries (RFC-0004).
        $and: [{ $or: visiblePageGrantOr(user._id) }, { $or: visiblePageStatusOr(user._id) }],
      })
        .select('_id path updatedAt')
        .limit(200)
        .lean()
        .exec()) as Array<{ _id: { toString(): string }; path: string; updatedAt?: Date }>;

      const results: AutocompleteResult[] = candidates
        .map((c) => {
          const leaf = pathLeaf(c.path);
          const score = scoreCandidate(
            [
              { text: c.path, weight: 30 },
              { text: leaf, weight: 15 },
            ],
            q,
          );
          return { c, leaf, score };
        })
        .filter((entry) => entry.score > 0)
        .sort((a, b) => b.score - a.score || a.c.path.localeCompare(b.c.path))
        .slice(0, limit)
        .map((entry) => ({
          id: entry.c._id.toString(),
          label: entry.c.path,
          // Show the leaf only when it differs from the full path
          // (a top-level page's leaf *is* its path).
          display: entry.leaf && entry.leaf !== entry.c.path ? `${entry.c.path} — ${entry.leaf}` : entry.c.path,
          modifiedAt: toISOStringOrNull(entry.c.updatedAt),
          score: entry.score,
        }));

      return { status: 200 as const, body: { results } };
    },
  });

  createExpressEndpoints(apiContract.autocomplete, autocompleteRouter, router);

  return router;
};
