import { initContract } from '@ts-rest/core';
import { AutocompleteRequestSchema, AutocompleteRateLimitErrorSchema, AutocompleteResponseSchema } from '../schemas/autocomplete';
import { AuthenticationRequiredErrorSchema, ValidationErrorSchema } from '../schemas/common';

const c = initContract();

/**
 * RFC-0004 Phase 5 — autocomplete contract.
 *
 * Standalone namespace (not folded into `userContract` / `pageContract`)
 * so the two editor-completion endpoints are discoverable as one bundle,
 * mirroring how `draftContract` keeps the draft-page surface separate.
 * Both endpoints run inside the authenticated router (`jwtAuth` applied
 * at mount time) and feed the CodeMirror `@username` / `[[page]]`
 * dropdowns. See `docs/rfcs/0004-editor-ux-enhancement.md` §"Autocomplete".
 *
 * Matching, permission filtering, and rate limiting are server-side
 * concerns documented per-operation below; the client only debounces,
 * caches (LRU), and renders.
 */
export const autocompleteContract = c.router({
  /**
   * GET /api/v2/users/autocomplete?q=<prefix>&limit=10
   *
   * Suggest users for an `@<char>` mention. Server matches `username`
   * (highest), display name, then email-local-part, ranked
   * prefix > substring > fuzzy. Only active users are returned.
   *
   *   - 200 `{ results }` ranked, capped at `limit`.
   *   - 429 `{ error: 'rate_limited' }` + `Retry-After` when the
   *     per-user budget (60 req/min) is exhausted.
   */
  autocompleteUsers: {
    method: 'GET',
    path: '/users/autocomplete',
    query: AutocompleteRequestSchema,
    responses: {
      200: AutocompleteResponseSchema,
      400: ValidationErrorSchema,
      401: AuthenticationRequiredErrorSchema,
      429: AutocompleteRateLimitErrorSchema,
    },
    summary: 'Autocomplete users for an @mention',
  },

  /**
   * GET /api/v2/pages/autocomplete?q=<prefix>&limit=10
   *
   * Suggest pages for a `[[` wikilink. Server matches the full path
   * (highest) then the path leaf ("title"), ranked
   * prefix > substring > fuzzy. Results are permission-filtered to
   * pages the caller can read; draft pages are excluded unless the
   * caller is the draft's author.
   *
   *   - 200 `{ results }` ranked, capped at `limit`.
   *   - 429 `{ error: 'rate_limited' }` + `Retry-After` when the
   *     per-user budget (60 req/min) is exhausted.
   */
  autocompletePages: {
    method: 'GET',
    path: '/pages/autocomplete',
    query: AutocompleteRequestSchema,
    responses: {
      200: AutocompleteResponseSchema,
      400: ValidationErrorSchema,
      401: AuthenticationRequiredErrorSchema,
      429: AutocompleteRateLimitErrorSchema,
    },
    summary: 'Autocomplete pages for a [[wikilink]]',
  },
});
