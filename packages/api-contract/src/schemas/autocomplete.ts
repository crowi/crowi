import { z } from 'zod';

/**
 * RFC-0004 Phase 5 — schemas for the autocomplete endpoints
 * (`GET /api/v2/users/autocomplete`, `GET /api/v2/pages/autocomplete`).
 *
 * Autocomplete powers the editor's `@username` / `[[page]]` dropdowns.
 * Both endpoints share one query shape and one result shape so the
 * CodeMirror extension can drive them through a single code path; the
 * `kind`-specific fields (`avatar` for users, `modifiedAt` for pages)
 * are optional. See `docs/rfcs/0004-editor-ux-enhancement.md`
 * §"Autocomplete".
 */

/**
 * Query for both autocomplete endpoints. `q` is the prefix the user has
 * typed after the trigger (`@` / `[[`); `limit` caps the candidate
 * count (the client requests 10, the server hard-caps at 25 so a
 * crafted request cannot fan out an unbounded scan).
 */
export const AutocompleteRequestSchema = z.object({
  q: z.string().min(1).max(128),
  limit: z.coerce.number().int().min(1).max(25).optional().default(10),
});
export type AutocompleteRequest = z.infer<typeof AutocompleteRequestSchema>;

/**
 * A single autocomplete candidate. The three text fields realise the
 * RFC's "display in dropdown / insert as Markdown / render at view
 * time" separation:
 *   - `label`   — canonical text inserted into the document
 *                 (`username` for users, full page `path` for pages).
 *   - `display` — human-readable label shown in the dropdown row.
 *   - `avatar`  — user only: avatar image URL (may be absent).
 *   - `modifiedAt` — page only: ISO timestamp shown as "2 days ago".
 *   - `score`   — server-computed rank (higher = better match); the
 *                 client keeps the server order but exposes it for
 *                 future tie-breaking.
 */
export const AutocompleteResultSchema = z.object({
  id: z.string(),
  label: z.string(),
  display: z.string(),
  avatar: z.string().nullable().optional(),
  modifiedAt: z.string().nullable().optional(),
  score: z.number(),
});
export type AutocompleteResult = z.infer<typeof AutocompleteResultSchema>;

/**
 * Success body for both autocomplete endpoints. `results` is already
 * permission-filtered and ranked (prefix > substring > fuzzy); the
 * client renders it verbatim.
 */
export const AutocompleteResponseSchema = z.object({
  results: z.array(AutocompleteResultSchema),
});
export type AutocompleteResponse = z.infer<typeof AutocompleteResponseSchema>;

/**
 * 429 body for either autocomplete endpoint when the per-user rate
 * limit (60 req/min) is exceeded. The client closes the dropdown
 * silently on 429, so the body is informational only; a `Retry-After`
 * header carries the machine-readable cooldown.
 */
export const AutocompleteRateLimitErrorSchema = z.object({
  error: z.literal('rate_limited'),
  message: z.string(),
  retryAfterSeconds: z.number(),
});
export type AutocompleteRateLimitError = z.infer<typeof AutocompleteRateLimitErrorSchema>;
