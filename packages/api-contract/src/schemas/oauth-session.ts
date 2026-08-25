import { z } from '@hono/zod-openapi';

/**
 * Wire schema for `GET/DELETE /me/oauth-sessions`.
 *
 * One row is one active `OAuthRefreshToken` rotation-chain tip, NOT a stable "session" identifier — the public `id` is the tip document's `_id`, which changes on every rotation.
 *
 * `lastRefreshedAt` is the tip's `createdAt` (when it was minted by rotation or the original grant), never an API-access timestamp — no such timestamp is tracked.
 *
 * Only non-secret metadata is exposed: no `tokenHash`, refresh-token plaintext, or client secret.
 */
export const OAuthSessionSchema = z.object({
  id: z.string(),
  clientId: z.string(),
  clientName: z.string(),
  scopes: z.array(z.string()),
  /** ISO-8601 — when the rotation chain this tip belongs to was first authorized. */
  authorizedAt: z.string().datetime(),
  /** ISO-8601 — when this tip document was minted (the chain's last rotation, or its origin grant). */
  lastRefreshedAt: z.string().datetime(),
  /** ISO-8601 — this tip's own expiry (TTL-swept past this instant). */
  expiresAt: z.string().datetime(),
});
export type OAuthSession = z.infer<typeof OAuthSessionSchema>;

export const ListOAuthSessionsResponseSchema = z.object({
  oauthSessions: z.array(OAuthSessionSchema),
});
export type ListOAuthSessionsResponse = z.infer<typeof ListOAuthSessionsResponseSchema>;
