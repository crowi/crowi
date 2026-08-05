/**
 * RFC-0014 phase 1 — the phase boundary the federated-auth callback
 * handler delegates to once a provider profile has been verified
 * (state/PKCE/id_token all checked; the OAuth2 `fetchProfile` /
 * OIDC `authorize` policy gate has already passed).
 *
 * Phase 1's default implementation (`createUnavailableFederatedProfileTerminal`)
 * never reads or writes `User` / `UserIdentity` — it always declines. Phase 2
 * supplies the real implementation (JIT provisioning / identity lookup)
 * WITHOUT changing this interface (RFC-0014 umbrella §"実装順序" 7) — only
 * `packages/api/src/hono/handlers/federated-auth.ts`'s call site swaps which
 * `FederatedProfileTerminal` it constructs.
 */
import type { AuthProfile } from '@crowi/plugin-api';

import type { UserDocument } from 'src/models/user';

/**
 * Allow-listed redirect error codes a terminal may return in the
 * `redirect_error` arm — appended as `?error=<code>` to the trusted web
 * `/login` page (RFC-0014 phase 1 §"契約・不変条件": never leak internal
 * detail). Phase 1's only producer (`createUnavailableFederatedProfileTerminal`)
 * only ever returns `'registration_unavailable'`. Phase 2/3 add their own
 * literals to this union (an additive, non-breaking change) without
 * reshaping `FederatedProfileTerminalResult` itself.
 */
export type FederatedRedirectErrorCode = 'registration_unavailable';

export type FederatedProfileTerminalResult = { kind: 'resolved'; user: UserDocument } | { kind: 'redirect_error'; code: FederatedRedirectErrorCode };

export interface FederatedProfileTerminalRequest {
  /** Driver name the profile came from (e.g. `'google'`). */
  provider: string;
  profile: AuthProfile;
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
