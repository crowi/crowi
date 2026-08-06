/**
 * RFC-0014 phase 2 — federated registration screen + JIT provisioning.
 *
 * Wire schemas for the three public `federated-registration` routes:
 *   GET  /auth/federated-registration/{token}         — read-only snapshot
 *   POST /auth/federated-registration/{token}         — submit the chosen
 *                                                        username
 *   POST /auth/federated-registration/{token}/logout   — cancel the pending
 *                                                        registration
 *
 * `{token}` is the one-time registration grant Phase 1's callback mints when
 * it hands a verified-but-unknown federated profile to
 * `createAuthRegistrationTerminal` (`packages/api/src/services/auth-
 * registration.ts`) — see that module's header for the full grant lifecycle.
 *
 * The submit success shape for a fully-activated (Open mode) registration is
 * a Phase 1 sender-constrained handoff `code` (AC-4/AC-8), NOT a raw token
 * pair: `{token}` above reached this browser via a URL redirect from Phase
 * 1's callback — the same leak surface (referrer/history/logs) that
 * motivated Phase 1's OWN handoff mechanism for its `code` — so a leaked
 * registration URL alone must not be able to yield real tokens. The submit
 * request carries `username` ONLY — it never supplies a sender key: the
 * server binds the issued code to the ORIGINAL `/auth/providers/{name}/start`
 * sender key that this journal row's grant was minted against
 * (`PendingAuthRegistration.handoffJkt`, captured from the OAuth callback
 * that created this row). A holder of a merely-stolen registration URL
 * therefore cannot rebind the eventual handoff to a key of their own
 * choosing — only the browser that originally proved control of that key can
 * redeem the resulting code via `POST /auth/handoff`.
 */
import { z } from '@hono/zod-openapi';

import { UsernameSchema } from './username';

export const FederatedRegistrationSnapshotSchema = z.object({
  /** IdP-verified email, prefilled read-only on the registration screen. */
  email: z.string().email(),
  /** Driver slug, e.g. `'google'`. */
  provider: z.string(),
  /** Human-friendly provider name (the driver's `buttonLabel`), e.g. `'Google'`. */
  providerLabel: z.string(),
});

export const FederatedRegistrationSubmitRequestSchema = z.object({
  username: UsernameSchema,
});

/** Open mode: the account is fully ACTIVE — a Phase 1 handoff `code`, redeemed via `POST /auth/handoff` (never a raw token pair — AC-4/AC-8). */
export const FederatedRegistrationActiveResultSchema = z.object({
  status: z.literal('active'),
  code: z.string(),
});

/** Restricted mode: the account is REGISTERED and awaits admin approval. */
export const FederatedRegistrationApprovalResultSchema = z.object({
  status: z.literal('approval_required'),
});

export const FederatedRegistrationResultSchema = z.discriminatedUnion('status', [
  FederatedRegistrationActiveResultSchema,
  FederatedRegistrationApprovalResultSchema,
]);
