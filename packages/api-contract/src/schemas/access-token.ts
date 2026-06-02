import { z } from '@hono/zod-openapi';

/**
 * RFC-0010 §Token model — Personal Access Token (PAT) wire schemas.
 *
 * A PAT's secret is an opaque `crowi_pat_…` string. The server stores only
 * its SHA-256 hash, so the plaintext is returned **once**, by `POST
 * /me/access-tokens`, and never again. Every other shape here exposes
 * metadata only (`id` / `name` / `scopes` / timestamps) — no `tokenHash`,
 * no plaintext.
 */

/** PAT metadata as returned by list / create (minus the one-time plaintext). */
export const AccessTokenSchema = z.object({
  id: z.string(),
  name: z.string(),
  scopes: z.array(z.string()),
  /** ISO-8601 expiry, or `null` for a non-expiring token. */
  expiresAt: z.string().nullable(),
  /** ISO-8601 of last successful use, or `null` if never used. */
  lastUsedAt: z.string().nullable(),
  createdAt: z.string(),
});
export type AccessToken = z.infer<typeof AccessTokenSchema>;

export const ListAccessTokensResponseSchema = z.object({
  accessTokens: z.array(AccessTokenSchema),
});
export type ListAccessTokensResponse = z.infer<typeof ListAccessTokensResponseSchema>;

/**
 * Create-PAT request. `scopes` is validated against `ISSUABLE_SCOPES`
 * (catalog scopes minus `admin:*`) in the handler — kept loose as
 * `z.string()` here so an out-of-catalog value yields the handler's
 * domain 400 rather than a Zod parse error. `expiresAt` is an ISO-8601
 * string or `null` (= non-expiring, RFC-0010 allows it; the web UI
 * additionally offers presets so "never expires" is an explicit choice).
 */
export const CreateAccessTokenRequestSchema = z.object({
  name: z.string().min(1, 'Name is required').max(200),
  scopes: z.array(z.string()).min(1, 'At least one scope is required'),
  expiresAt: z.string().datetime().nullable().optional(),
});
export type CreateAccessTokenRequest = z.infer<typeof CreateAccessTokenRequestSchema>;

/**
 * Create-PAT response: the new token's metadata plus the one-time
 * plaintext `token` (`crowi_pat_…`). The client must surface `token`
 * immediately — it is not recoverable afterwards.
 */
export const CreateAccessTokenResponseSchema = AccessTokenSchema.extend({
  token: z.string(),
});
export type CreateAccessTokenResponse = z.infer<typeof CreateAccessTokenResponseSchema>;

/** 400 returned when a requested scope is outside `ISSUABLE_SCOPES`. */
export const InvalidScopeErrorSchema = z.object({
  error: z.object({
    code: z.literal('INVALID_SCOPE'),
    message: z.string(),
    details: z
      .object({
        invalidScopes: z.array(z.string()),
      })
      .optional(),
  }),
});
export type InvalidScopeError = z.infer<typeof InvalidScopeErrorSchema>;
