/**
 * RFC-0014 phase 1 — federated (OAuth2/OIDC) sign-in flow skeleton, plus
 * the account-link flow (3 additional authenticated routes; see the
 * "Account linking" section below).
 *
 * Wire schemas for the public `federated-auth` sign-in routes:
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
import { ApiErrorSchema } from './common';

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
 * RFC-0014 phase 4 — which providers the CURRENT user has connected.
 *
 * Only provider slugs: never the provider-side account id, email or
 * display name. The settings screen needs to know whether to offer Link
 * or Unlink, and nothing more — returning the identity itself would put
 * a third party's account identifier into a page that has no use for it.
 */
export const LinkedAuthProviderListResponseSchema = z.object({
  identities: z.array(z.object({ provider: z.string() })),
});

/**
 * Schemas for account linking (3-stage flow:
 * authenticated `POST link-start` -> DB-free callback completion ->
 * authenticated confirmation `GET`/final `POST link-completions/{code}`).
 *
 * `LinkCompletionCodeSchema`: 32 random bytes, base64url — 43 characters,
 * matching `LINK_COMPLETION_CODE_BYTES` (`service/link-completion.ts`).
 */
export const LinkCompletionCodeSchema = z.string().regex(/^[A-Za-z0-9_-]{43}$/, 'must be a 43-character base64url completion code');

/** `POST link-start`'s success body — the browser navigates here with `window.location.assign(...)`. */
export const StartProviderLinkResponseSchema = z.object({
  authorizationUrl: z.string().url(),
});

/**
 * `GET link-completions/{code}`'s success body — the confirmation dialog's
 * content. `accountLabel` is optional and display-only (`profile.email`,
 * omitted when it would push the completion record over its byte budget —
 * `service/link-completion.ts` design decision 22). Never `providerUserId`
 * (out of scope §"やらないこと").
 */
export const PendingLinkCompletionResponseSchema = z.object({
  provider: z.string(),
  accountLabel: z.string().optional(),
});

/** Both the final `POST`'s fresh-winner success AND an already-consumed replay's `linked` outcome share this one 200 body (spec design decision 18). */
export const CompleteProviderLinkResponseSchema = z.object({
  result: z.literal('linked'),
});

/** `GET link-completions/{code}` 409 — the caller's OWN prior consume. Non-destructive: repeatable, never re-derives a different result. */
export const LinkCompletionConsumedErrorSchema = ApiErrorSchema.extend({
  error: z.object({
    code: z.literal('LINK_COMPLETION_CONSUMED'),
    message: z.string(),
  }),
});

/**
 * Final `POST link-completions/{code}` 409 vocabulary (spec design decision
 * 18) — no `FEDERATED_LINK_RESULT_UNKNOWN` code exists; every replay result
 * collapses to one of these three or the shared 200 `linked`.
 *
 *   - `FEDERATED_IDENTITY_IN_USE` — the provider account is linked to a
 *     DIFFERENT Crowi user, or this user already has a DIFFERENT account
 *     of the same provider linked. Never names the other owner.
 *   - `FEDERATED_LINK_AUTH_STATE_CHANGED` — the fresh `User` re-read after
 *     consume found the session inactive or its `authVersion` bumped
 *     (password reset / forced sign-out) since `link-start`.
 *   - `FEDERATED_LINK_NOT_LINKED` — an already-consumed replay whose
 *     original insert has not (yet, or ever) landed.
 */
export const CompleteProviderLinkConflictErrorSchema = ApiErrorSchema.extend({
  error: z.object({
    code: z.enum(['FEDERATED_IDENTITY_IN_USE', 'FEDERATED_LINK_AUTH_STATE_CHANGED', 'FEDERATED_LINK_NOT_LINKED']),
    message: z.string(),
  }),
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
