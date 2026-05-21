/**
 * RFC-0006 Phase 4 Batch 6 — `autocomplete` resource ported to
 * `@hono/zod-openapi` route definitions. Two endpoints (RFC-0004
 * Phase 5):
 *
 *   GET /users/autocomplete  — suggest users for an @mention
 *   GET /pages/autocomplete  — suggest pages for a [[wikilink]]
 *
 * Auth + rate limiting:
 *   - `/pages/autocomplete` reuses the `revision` handler's broad
 *     `/pages/*` `createJwtAuth(crowi)` apply (registered first in
 *     `buildHonoApp` — same dedupe-avoidance rationale as the rest
 *     of the `/pages/*` family).
 *   - `/users/autocomplete` is OUTSIDE that prefix, so the autocomplete
 *     handler installs `createJwtAuth(crowi)` on `/users/autocomplete`
 *     itself (a single-route install, no other resource owns that path
 *     today).
 *   - Both endpoints additionally apply `withRateLimit({ name:
 *     'autocomplete', limit: 60, windowMs: 60_000 })` AFTER jwtAuth so
 *     the limiter has `c.get('user')`.
 *
 * The 429 wire shape is preserved verbatim — `Retry-After` header +
 * `{ error: 'rate_limited', message, retryAfterSeconds }` body.
 */
import { createRoute } from '@hono/zod-openapi';

import { AuthenticationRequiredErrorSchema, ValidationErrorSchema } from '../schemas/common';
import { AutocompleteRateLimitErrorSchema, AutocompleteRequestSchema, AutocompleteResponseSchema } from '../schemas/autocomplete';

export const autocompleteUsersRoute = createRoute({
  method: 'get',
  path: '/users/autocomplete',
  tags: ['autocomplete'],
  security: [{ bearerAuth: [] }],
  summary: 'Autocomplete users for an @mention',
  request: {
    query: AutocompleteRequestSchema,
  },
  responses: {
    200: {
      description: 'Ranked user candidates',
      content: { 'application/json': { schema: AutocompleteResponseSchema } },
    },
    400: {
      description: 'Validation error',
      content: { 'application/json': { schema: ValidationErrorSchema } },
    },
    401: {
      description: 'Authentication required',
      content: { 'application/json': { schema: AuthenticationRequiredErrorSchema } },
    },
    429: {
      description: 'Per-user rate limit exceeded',
      content: { 'application/json': { schema: AutocompleteRateLimitErrorSchema } },
    },
  },
});

export const autocompletePagesRoute = createRoute({
  method: 'get',
  path: '/pages/autocomplete',
  tags: ['autocomplete'],
  security: [{ bearerAuth: [] }],
  summary: 'Autocomplete pages for a [[wikilink]]',
  request: {
    query: AutocompleteRequestSchema,
  },
  responses: {
    200: {
      description: 'Ranked page candidates (permission-filtered)',
      content: { 'application/json': { schema: AutocompleteResponseSchema } },
    },
    400: {
      description: 'Validation error',
      content: { 'application/json': { schema: ValidationErrorSchema } },
    },
    401: {
      description: 'Authentication required',
      content: { 'application/json': { schema: AuthenticationRequiredErrorSchema } },
    },
    429: {
      description: 'Per-user rate limit exceeded',
      content: { 'application/json': { schema: AutocompleteRateLimitErrorSchema } },
    },
  },
});

export const autocompleteRoutes = {
  autocompleteUsersRoute,
  autocompletePagesRoute,
};
