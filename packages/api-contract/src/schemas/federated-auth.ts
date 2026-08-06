/**
 * RFC-0014 phase 1 — federated (OAuth2/OIDC) sign-in flow skeleton.
 *
 * Wire schemas for the four public `federated-auth` routes:
 *   GET  /auth/providers                — enabled provider list
 *   GET  /auth/providers/{name}/start   — redirect to the IdP
 *   GET  /auth/providers/{name}/callback — IdP redirect target
 *   POST /auth/handoff                  — exchange a sender-constrained
 *                                          handoff code for session tokens
 *
 * `start` / `callback` are real HTTP redirects (top-level browser
 * navigations), not JSON endpoints — see `contracts/federated-auth.ts` for
 * how a content-less `302` response is declared. `handoff`'s success body
 * is `FederatedHandoffResponseSchema` — a direct re-export of
 * `TokenAuthResponseSchema` (see the umbrella spec's contract invariant:
 * the field names must never drift from password login). Kept as an
 * explicitly named symbol in this file (rather than importing
 * `TokenAuthResponseSchema` straight into `contracts/federated-auth.ts`, the
 * way `password-reset.ts` / `activation.ts` / `invite-accept.ts` do) because
 * the phase 1 implementation map names `FederatedHandoffResponseSchema` as
 * this module's own wire contract for the handoff response, independent of
 * which internal schema happens to back it today.
 */
import { z } from '@hono/zod-openapi';

import { TokenAuthResponseSchema } from './auth';

export const FederatedProviderSchema = z.object({
  name: z.string(),
  buttonLabel: z.string(),
  iconUrl: z.string().optional(),
});

export const ProviderListResponseSchema = z.object({
  providers: z.array(FederatedProviderSchema),
});

/**
 * A P-256 public JWK, base64url-thumbprinted (RFC 7638) server-side and
 * used only to verify an ES256 signature — see
 * `util/federated-auth-state.ts#verifySenderProof`. Never treated as a
 * bearer capability by itself: the accompanying `signature` is what proves
 * possession of the matching private key.
 */
export const SenderPublicJwkSchema = z.object({
  kty: z.literal('EC'),
  crv: z.literal('P-256'),
  x: z.string(),
  y: z.string(),
});

export const SenderProofSchema = z.object({
  publicJwk: SenderPublicJwkSchema,
  /** base64url ES256 signature over the canonical handoff message. */
  signature: z.string(),
});

export const FederatedHandoffRequestSchema = z.object({
  code: z.string(),
  proof: SenderProofSchema,
});

/** Same shape as `POST /auth/login`'s success body — see this file's header. */
export const FederatedHandoffResponseSchema = TokenAuthResponseSchema;

/**
 * RFC-0014 phase 3 — linking a provider account to an already signed-in
 * user.
 *
 * The request carries ONLY the sender-key thumbprint the caller will also
 * present at `/start`. It deliberately does NOT carry a user id: the target
 * is taken from the authenticated session server-side, so nothing a client
 * sends can aim the link at someone else's account (spec §契約
 * "state の `linkToUserId` は authenticated start request の user からだけ
 * 設定し、callback query / client-supplied id から設定しない").
 */
export const CreateLinkGrantRequestSchema = z.object({
  /** RFC 7638 thumbprint of the P-256 public key this browser will use at `/start` — binds the grant to this browser (AC-2). */
  handoffChallenge: z.string().min(1),
});

/** The opaque, single-use id `/start?link=1&link_grant=…` expects. Carries no readable claims — every bound value stays server-side. */
export const CreateLinkGrantResponseSchema = z.object({
  linkGrant: z.string(),
});

/**
 * Unlink refusals. Both are 409 and neither reveals how many identities
 * remain or who else might own one — the caller learns only what they can
 * act on. `FEDERATED_UNLINK_DISABLED` is fixed instance policy (password
 * auth is off, so unlinking could strand the account); `PASSWORD_REQUIRED`
 * is actionable by the user (set a password first).
 */
export const UnlinkAuthProviderErrorSchema = z.object({
  error: z.object({
    code: z.enum(['FEDERATED_UNLINK_DISABLED', 'PASSWORD_REQUIRED']),
    message: z.string(),
  }),
});
