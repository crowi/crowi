/**
 * RFC-0014 phase 1 — the phase boundary the federated-auth callback
 * handler delegates to once a provider profile has been verified
 * (state/PKCE/id_token all checked; the OAuth2 `fetchProfile` /
 * OIDC `authorize` policy gate has already passed).
 *
 * Phase 1's default implementation (`createUnavailableFederatedProfileTerminal`)
 * never reads or writes `User` / `UserIdentity` — it always declines. Phase 2
 * (`packages/api/src/services/auth-registration.ts#createAuthRegistrationTerminal`)
 * supplies the real implementation (identity lookup + JIT-registration grant
 * issuance) — only `packages/api/src/hono/handlers/federated-auth.ts`'s call
 * site swaps which `FederatedProfileTerminal` it constructs. This DOES grow
 * the interface additively (the `registration` result kind + the
 * `providerLabel`/`handoffJkt` request fields below): Phase 1 shipped before
 * Phase 2's exact registration-screen contract was designed, so the original
 * "no interface change" note undersold what Phase 2 needed — the growth
 * stays additive/backward-compatible, not a reshape of the existing
 * `resolved` / `redirect_error` arms.
 *
 * This IS the extension point the umbrella spec's own phase table names for
 * Phase 1: `feature-auth-plugin-google.md`'s phase-1 row is scoped as
 * "providers / start / callback / handoff、state cookie、PKCE、id_token 検証、
 * JWT bridge。**provisioning と linking の分岐先はインターフェースのみ**"
 * (emphasis in the original — "the branch destinations for provisioning and
 * linking are INTERFACE-ONLY"). `FederatedProfileTerminal` IS that
 * interface; Phase 2 concretizing what it needed to carry (a grant token
 * for the registration branch, the sender-proof thumbprint the grant binds
 * its eventual handoff to) is exactly what that phase boundary was designed
 * to require of a later phase, not an out-of-scope change to Phase 1's own
 * OAuth/OIDC protocol code (state cookie, PKCE, id_token verification, JWT
 * bridge — none of which this file, or Phase 2, touches).
 */
import type { AuthProfile } from '@crowi/plugin-api';

import type { UserDocument } from 'src/models/user';

/**
 * Allow-listed redirect error codes a terminal may return in the
 * `redirect_error` arm — appended as `?error=<code>` to the trusted web
 * `/login` page (RFC-0014 phase 1 §"契約・不変条件": never leak internal
 * detail). Phase 1's only producer (`createUnavailableFederatedProfileTerminal`)
 * only ever returns `'registration_unavailable'`; Phase 2's terminal also
 * returns `'registration_closed'` / `'email_not_allowed'` /
 * `'email_already_registered'` (registration-mode gating and the "no
 * auto-link" rule — RFC-0014 §5.2/§5.4). Phase 3 may add its own literals
 * the same additive way.
 */
export type FederatedRedirectErrorCode = 'registration_unavailable' | 'registration_closed' | 'email_not_allowed' | 'email_already_registered';

export type FederatedProfileTerminalResult =
  | { kind: 'resolved'; user: UserDocument }
  | { kind: 'redirect_error'; code: FederatedRedirectErrorCode }
  /** Phase 2 — unknown-but-verified identity: no `User` was created. `token` is the one-time federated-registration grant; the callback redirects to `/register/federated?token=<token>`. */
  | { kind: 'registration'; token: string };

export interface FederatedProfileTerminalRequest {
  /** Driver name the profile came from (e.g. `'google'`). */
  provider: string;
  profile: AuthProfile;
  /** Phase 2 — the driver's human-friendly `buttonLabel` (e.g. `'Google'`), prefilled read-only on the registration screen. Phase 1's default terminal ignores it. */
  providerLabel: string;
  /**
   * Phase 2 — RFC 7638 JWK thumbprint of the sender key that proved control
   * of the ORIGINAL `/auth/providers/{name}/start` request (this callback's
   * own `FederatedAuthState.handoffJkt`). The registration terminal
   * persists this onto `PendingAuthRegistration` and binds the eventual
   * handoff to it — a stolen registration URL alone can never rebind the
   * handoff to an attacker-supplied key (AC-8). Phase 1's default terminal
   * ignores it (it never issues a handoff itself).
   */
  handoffJkt: string;
}

export interface FederatedProfileTerminal {
  resolve(request: FederatedProfileTerminalRequest): Promise<FederatedProfileTerminalResult>;
}

/**
 * Phase 1 default: always declines with `registration_unavailable`. No
 * provisioning, no identity lookup, no `User`/`UserIdentity` read or
 * write — Phase 2 replaces this with the real implementation.
 */
export function createUnavailableFederatedProfileTerminal(): FederatedProfileTerminal {
  return {
    async resolve() {
      return { kind: 'redirect_error', code: 'registration_unavailable' };
    },
  };
}
