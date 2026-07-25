/**
 * RFC-0006 Phase 4 Batch 6 — `autocomplete` resource Hono port.
 *
 * Replaces `packages/api/src/routes/ts-rest/autocomplete.ts`. Two
 * endpoints (RFC-0004 Phase 5):
 *
 *   GET /users/autocomplete  — suggest users for an @mention
 *   GET /pages/autocomplete  — suggest pages for a [[wikilink]]
 *
 * Auth split:
 *  - `/pages/autocomplete` rides the `revision` handler's broad
 *    `createJwtAuth(crowi)` apply on `/pages/*` (same shared-middleware
 *    pattern as `page` / `page-preview` / `pageCollab` / `presence` /
 *    `draft`).
 *  - `/users/autocomplete` is OUTSIDE that prefix. We install jwtAuth
 *    on the single literal path here — no other handler owns `/users/*`
 *    so there is no risk of double-apply.
 *
 * Rate limiting:
 *  - 60 req/min/user, name `'autocomplete'`. Same shared
 *    `createRateLimiter(...)` instance for both endpoints (the limiter
 *    keys on `userId` so cross-endpoint usage still counts against the
 *    same budget — matches the ts-rest era).
 *  - Applied AFTER jwtAuth so `c.get('user')` is populated.
 *  - 429 envelope: `{ error: 'rate_limited', message,
 *    retryAfterSeconds }` (`AutocompleteRateLimitErrorSchema`).
 */
import { type AutocompleteResult, autocompletePagesRoute, autocompleteUsersRoute } from '@crowi/api-contract';
import type { OpenAPIHono } from '@hono/zod-openapi';
import Debug from 'debug';

import type Crowi from 'src/crowi';
import { visiblePageGrantOr, visiblePageStatusOr } from 'src/models/page';
import { scoreCandidate } from 'src/util/autocomplete-match';
import { createRateLimiter } from 'src/util/rate-limit';
import { resolveRedisKeyspaceIfEnabled } from 'src/util/redis-keyspace';
import { escapeRegExp } from 'src/util/regex';
import { toISOStringOrNull } from 'src/util/ts-rest-helpers';

import type { CrowiHonoBindings } from '../app';
import { createJwtAuth } from '../middleware/auth';
import { withRateLimit } from '../middleware/rate-limit';
import { applyScope } from '../middleware/require-scope';

const debug = Debug('crowi:hono:handlers:autocomplete');

/** Per-user budget for the autocomplete endpoints — RFC §"Rate limit". */
const RATE_LIMIT = 60;
const RATE_WINDOW_MS = 60_000;

/**
 * Build the case-insensitive matcher for a candidate query. `'prefix'`
 * anchors at the start (`^…`) so only true prefixes match — the "create
 * page" modal needs this so cycling through completions of a `/`-rooted
 * path never surfaces a deep page that merely *contains* the typed text.
 * `'substring'` (the default) keeps the historical anywhere-in-string
 * match used by the editor pickers.
 */
const buildMatcher = (q: string, anchor: 'substring' | 'prefix'): RegExp => {
  const escaped = escapeRegExp(q);
  return new RegExp(anchor === 'prefix' ? `^${escaped}` : escaped, 'i');
};

/** Last `/`-separated segment of a wiki path — the page's "title". */
const pathLeaf = (path: string): string => {
  const trimmed = path.replace(/\/+$/, '');
  const idx = trimmed.lastIndexOf('/');
  return idx >= 0 ? trimmed.slice(idx + 1) : trimmed;
};

export const registerAutocompleteRoutes = <E extends OpenAPIHono<CrowiHonoBindings>>(app: E, crowi: Crowi) => {
  const User = crowi.model('User');
  const Page = crowi.model('Page');

  // One shared limiter per process. `crowi.redis` is `null` in
  // single-instance dev, which selects the in-memory fallback.
  const limiter = createRateLimiter({
    name: 'autocomplete',
    limit: RATE_LIMIT,
    windowMs: RATE_WINDOW_MS,
    redisClient: crowi.redis ?? null,
    keyspace: resolveRedisKeyspaceIfEnabled(crowi),
  });

  const rateLimitMiddleware = withRateLimit({
    limiter,
    wireShape: 'autocomplete-envelope',
    message: () => 'Autocomplete rate limit exceeded. Try again shortly.',
  });

  // `/users/autocomplete` is OUTSIDE the revision-owned `/pages/*`
  // apply — install jwtAuth on the literal path here.
  app.use('/users/autocomplete', createJwtAuth(crowi));
  // Rate limit (both endpoints share the bucket; apply per literal
  // path AFTER jwtAuth so `c.get('user')` is populated).
  app.use('/users/autocomplete', rateLimitMiddleware);
  app.use('/pages/autocomplete', rateLimitMiddleware);

  // RFC-0010 — autocomplete (page + mention pickers) is a page read.
  applyScope(app, autocompleteUsersRoute, 'pages:read');
  applyScope(app, autocompletePagesRoute, 'pages:read');

  return (
    app
      // --------------------------------------------------------------
      // GET /users/autocomplete
      // --------------------------------------------------------------
      .openapi(autocompleteUsersRoute, async (c) => {
        const user = c.get('user');
        const { q, limit, anchor } = c.req.valid('query');

        debug('autocompleteUsers', { q, limit, anchor, userId: user._id.toString() });

        // Widest cheap filter: case-insensitive substring on any of
        // the three fields. Fuzzy hits that are *not* substrings are
        // intentionally not surfaced — username typo tolerance is
        // low-value and the substring net already covers prefixes.
        const re = buildMatcher(q, anchor);
        const candidates = (await User.find({
          status: User.STATUS_ACTIVE,
          $or: [{ username: re }, { name: re }, { email: re }],
        })
          .select('_id username name email image')
          .limit(200)
          .lean()
          .exec()) as Array<{ _id: { toString(): string }; username?: string; name?: string; email?: string; image?: string | null }>;

        const results: AutocompleteResult[] = candidates
          .map((cand) => {
            const username = cand.username ?? '';
            const name = cand.name ?? '';
            const emailLocal = (cand.email ?? '').split('@')[0] ?? '';
            const score = scoreCandidate(
              [
                { text: username, weight: 30 },
                { text: name, weight: 20 },
                { text: emailLocal, weight: 10 },
              ],
              q,
            );
            return { cand, username, name, score };
          })
          .filter((entry) => entry.score > 0)
          .sort((a, b) => b.score - a.score || a.username.localeCompare(b.username))
          .slice(0, limit)
          .map((entry) => ({
            id: entry.cand._id.toString(),
            label: entry.username,
            display: entry.name ? `${entry.name} (@${entry.username})` : `@${entry.username}`,
            avatar: entry.cand.image ?? null,
            score: entry.score,
          }));

        return c.json({ results }, 200);
      })
      // --------------------------------------------------------------
      // GET /pages/autocomplete
      // --------------------------------------------------------------
      .openapi(autocompletePagesRoute, async (c) => {
        const user = c.get('user');
        const { q, limit, anchor } = c.req.valid('query');

        debug('autocompletePages', { q, limit, anchor, userId: user._id.toString() });

        const re = buildMatcher(q, anchor);
        const candidates = (await Page.find({
          redirectTo: null,
          path: re,
          // Grant-aware read filter + draft visibility, both shared
          // with the page listing queries (RFC-0004).
          $and: [{ $or: visiblePageGrantOr(user._id) }, { $or: visiblePageStatusOr(user._id) }],
        })
          .select('_id path updatedAt')
          .limit(200)
          .lean()
          .exec()) as Array<{ _id: { toString(): string }; path: string; updatedAt?: Date }>;

        const results: AutocompleteResult[] = candidates
          .map((cand) => {
            const leaf = pathLeaf(cand.path);
            const score = scoreCandidate(
              [
                { text: cand.path, weight: 30 },
                { text: leaf, weight: 15 },
              ],
              q,
            );
            return { cand, leaf, score };
          })
          .filter((entry) => entry.score > 0)
          .sort((a, b) => b.score - a.score || a.cand.path.localeCompare(b.cand.path))
          .slice(0, limit)
          .map((entry) => ({
            id: entry.cand._id.toString(),
            label: entry.cand.path,
            // Show the leaf only when it differs from the full path
            // (a top-level page's leaf *is* its path).
            display: entry.leaf && entry.leaf !== entry.cand.path ? `${entry.cand.path} — ${entry.leaf}` : entry.cand.path,
            modifiedAt: toISOStringOrNull(entry.cand.updatedAt),
            score: entry.score,
          }));

        return c.json({ results }, 200);
      })
  );
};
