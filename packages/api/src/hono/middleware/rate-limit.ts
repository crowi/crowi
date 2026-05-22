/**
 * RFC-0006 Phase 4 Batch 6 — Hono wrapper around `util/rate-limit.ts`.
 *
 * `createRateLimiter` is framework-agnostic (it just exposes
 * `limiter.hit(userId)`), so the Hono side is a thin adapter that:
 *
 *  1. resolves the calling user via `c.get('user')` — the middleware
 *     MUST be installed AFTER `createJwtAuth(crowi)` so the user is
 *     populated. Apply order is enforced at the registration site
 *     (e.g. `autocomplete.ts` / `attachment.ts`); guard at the
 *     middleware so a mis-order fails loudly.
 *  2. calls `limiter.hit(userId)` once per request.
 *  3. emits the wire-identical 429 envelopes used by the ts-rest era:
 *      - `autocomplete` → `{ error: 'rate_limited', message,
 *         retryAfterSeconds }` (top-level shape from
 *         `AutocompleteRateLimitErrorSchema`).
 *      - `attachment-upload` → `{ error: 'rate_limited', message,
 *         details: { retryAfterSeconds } }` (lowercase RFC-0004 envelope
 *         from `UploadAttachmentErrorSchema`).
 *     A `Retry-After` header (whole seconds) is set on both paths so
 *     non-JSON clients can back off without parsing the body.
 *  4. lets the request through (`await next()`) when within budget.
 *
 * Per-`crowi` limiter caching: `withRateLimit` itself does not own a
 * limiter — it is given one by the resource handler so a single
 * `createRateLimiter(...)` instance is shared across every request
 * (Redis backed when `crowi.redis !== null`, in-memory fallback
 * otherwise — see `util/rate-limit.ts`).
 */
import type { MiddlewareHandler } from 'hono';
import { createMiddleware } from 'hono/factory';

import type { RateLimiter } from 'src/util/rate-limit';

import type { CrowiHonoBindings } from '../app';

/**
 * Wire shape selector. Each migrated endpoint that needs rate-limiting
 * declares which envelope its 429 should use; the helper has no opinion
 * beyond matching the corresponding schema.
 *
 *  - `autocomplete-envelope` matches `AutocompleteRateLimitErrorSchema`:
 *    `{ error: 'rate_limited', message, retryAfterSeconds }`.
 *  - `attachment-upload-envelope` matches `UploadAttachmentErrorSchema`
 *    with `error: 'rate_limited'`:
 *    `{ error: 'rate_limited', message, details: { retryAfterSeconds } }`.
 */
export type RateLimitWireShape = 'autocomplete-envelope' | 'attachment-upload-envelope';

export interface WithRateLimitOptions {
  limiter: RateLimiter;
  /** Wire shape of the 429 body for this endpoint family. */
  wireShape: RateLimitWireShape;
  /** Human-readable message embedded in the 429 body. */
  message: (retryAfterSeconds: number) => string;
}

/**
 * Build a Hono middleware that counts one hit against `limiter` and
 * short-circuits with the configured 429 envelope when the per-user
 * budget is exceeded. MUST be installed AFTER `createJwtAuth(crowi)`.
 */
export const withRateLimit = (options: WithRateLimitOptions): MiddlewareHandler<CrowiHonoBindings> => {
  const { limiter, wireShape, message } = options;

  return createMiddleware<CrowiHonoBindings>(async (c, next) => {
    const user = c.get('user');
    if (!user) {
      // Defensive: jwtAuth populates `user`. A missing value here would
      // mean an apply-order bug at registration; surfacing it as a 401
      // (rather than a 500) keeps the wire predictable.
      return c.json({ error: { code: 'AUTHENTICATION_REQUIRED' as const, message: 'Authentication is required' as const } }, 401);
    }

    const result = await limiter.hit(user._id.toString());
    if (result.allowed) {
      await next();
      return;
    }

    c.header('Retry-After', String(result.retryAfterSeconds));

    if (wireShape === 'autocomplete-envelope') {
      return c.json(
        {
          error: 'rate_limited' as const,
          message: message(result.retryAfterSeconds),
          retryAfterSeconds: result.retryAfterSeconds,
        },
        429,
      );
    }

    // attachment-upload-envelope
    return c.json(
      {
        error: 'rate_limited' as const,
        message: message(result.retryAfterSeconds),
        details: { retryAfterSeconds: result.retryAfterSeconds },
      },
      429,
    );
  });
};
