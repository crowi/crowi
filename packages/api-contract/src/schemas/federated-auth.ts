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
