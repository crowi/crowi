import { z } from '@hono/zod-openapi';

import { ApiErrorSchema } from './common';

/**
 * RFC-0010 — OAuth 2.0 scope catalog (single source of truth).
 *
 * Scopes are resource-category × `read` / `write`, plus two umbrella
 * scopes (`read` / `write`) and two reserved admin scopes. The reserved
 * `admin:read` / `admin:write` are listed here for catalog completeness
 * (discovery `scopes_supported`, consent-screen rendering, and a single
 * canonical `Scope` union) even though Phase 1 has **no issuing path**
 * for them — admin API stays web-session-only in v1 (RFC-0010 §Design
 * decisions, OQ-C resolved: reserved only).
 *
 * `write` implies the same resource's `read`; umbrella `read` implies
 * every `*:read` and umbrella `write` implies every `*:write` (+ read).
 * The implication semantics live in `scopeSatisfies` below.
 */
export const SCOPES = [
  // umbrella
  'read',
  'write',
  // pages — page, revision, draft, backlink, search, autocomplete
  'pages:read',
  'pages:write',
  // comments
  'comments:read',
  'comments:write',
  // bookmarks
  'bookmarks:read',
  'bookmarks:write',
  // attachments
  'attachments:read',
  'attachments:write',
  // notifications
  'notifications:read',
  'notifications:write',
  // profile — me, user
  'profile:read',
  'profile:write',
  // reserved — admin API is web-session-only in v1 (no issuing path)
  'admin:read',
  'admin:write',
] as const;

export type Scope = (typeof SCOPES)[number];

/** Every catalog scope as a `Set`, used to grant web sessions all scopes. */
export const ALL_SCOPES: ReadonlySet<Scope> = new Set(SCOPES);

const SCOPE_SET: ReadonlySet<string> = new Set(SCOPES);

/** Type guard: is `value` a known catalog scope? */
export function isScope(value: string): value is Scope {
  return SCOPE_SET.has(value);
}

/**
 * Parse a space-delimited scope claim (RFC 6749 §3.3) into a `Set` of
 * recognised scopes. Unknown tokens are dropped silently — a token that
 * is not in the catalog cannot satisfy any `requireScope` check anyway,
 * so keeping it would only bloat the set.
 */
export function parseScopeClaim(claim: string | undefined | null): Set<Scope> {
  const out = new Set<Scope>();
  if (!claim) return out;
  for (const raw of claim.split(/\s+/)) {
    const token = raw.trim();
    if (token && isScope(token)) {
      out.add(token);
    }
  }
  return out;
}

/**
 * RFC-0010 §含意ルール — is the required scope `required` satisfied by the
 * granted set `granted`?
 *
 *   - `required ∈ granted`, or
 *   - `required = "x:read"` and `"x:write" ∈ granted`, or
 *   - `required = "x:read"` and (`"read" ∈ granted` or `"write" ∈ granted`), or
 *   - `required = "x:write"` and `"write" ∈ granted`
 *
 * `granted` is a `Set<string>` (not `Set<Scope>`) so callers can pass the
 * raw parsed claim without re-narrowing; unknown entries simply never
 * match.
 */
export function scopeSatisfies(required: string, granted: ReadonlySet<string>): boolean {
  // Direct grant.
  if (granted.has(required)) {
    return true;
  }

  const [resource, action] = required.split(':');
  // Umbrella requirements (`read` / `write` with no resource) are only
  // satisfiable by a direct grant, handled above.
  if (action === undefined) {
    return false;
  }

  if (action === 'read') {
    // write on the same resource implies read.
    if (granted.has(`${resource}:write`)) return true;
    // umbrella read or write implies any resource read.
    if (granted.has('read') || granted.has('write')) return true;
    return false;
  }

  if (action === 'write') {
    // umbrella write implies any resource write.
    if (granted.has('write')) return true;
    return false;
  }

  return false;
}

/**
 * 403 returned by `requireScope` when the authenticated principal's token
 * lacks the scope a route requires. Mirrors RFC 6750 `insufficient_scope`
 * (also surfaced via the `WWW-Authenticate` response header). `details`
 * carries the missing scope so clients / SDKs can prompt for re-consent.
 */
export const InsufficientScopeErrorSchema = ApiErrorSchema.extend({
  error: z.object({
    code: z.literal('INSUFFICIENT_SCOPE'),
    message: z.string(),
    details: z
      .object({
        requiredScope: z.string(),
      })
      .optional(),
  }),
});

export type InsufficientScopeError = z.infer<typeof InsufficientScopeErrorSchema>;
