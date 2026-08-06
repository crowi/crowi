/**
 * RFC-0014 phase 2 — federated registration screen + JIT provisioning.
 *
 *   GET  /auth/federated-registration/{token}         — read-only snapshot
 *   POST /auth/federated-registration/{token}         — submit the chosen
 *                                                        username
 *   POST /auth/federated-registration/{token}/logout   — cancel the pending
 *                                                        registration
 *
 * Public: `{token}` (the one-time `PendingAuthRegistration` grant Phase 1's
 * callback mints — see `src/services/auth-registration.ts`) is the
 * credential, same convention as `activation.ts` / `invite-accept.ts` /
 * `password-reset.ts`. Unknown, expired, and cancelled grants all collapse
 * to the same 404 (never distinguished) per the phase 2 spec's contract
 * section.
 */
import { getFederatedRegistrationRoute, logoutFederatedRegistrationRoute, submitFederatedRegistrationRoute } from '@crowi/api-contract';
import type { OpenAPIHono, RouteHandler } from '@hono/zod-openapi';
import Debug from 'debug';

import type Crowi from 'src/crowi';
import type { FederatedHandoffStore } from 'src/service/federated-handoff';
import { provisionPendingRegistration, terminalExpiry } from 'src/services/auth-registration';

import type { CrowiHonoBindings } from '../app';

import { INTERNAL_ERROR_BODY } from './_helpers/errors';

const debug = Debug('crowi:hono:handlers:federatedRegistration');

const GRANT_NOT_FOUND_BODY = { error: { code: 'NOT_FOUND' as const, message: 'Registration grant is unknown, expired, or cancelled' } };
const VALIDATION_ERROR_BODY = {
  error: { code: 'VALIDATION_ERROR' as const, message: 'username may only contain letters, digits, hyphens, and underscores (1-64 characters)' },
};

export interface FederatedRegistrationRouteDeps {
  crowi: Crowi;
  /** MUST be the SAME instance passed to `registerFederatedAuthRoutes` — see `hono/index.ts`'s call site. */
  handoffStore: FederatedHandoffStore;
}

export function getPendingRegistration(deps: FederatedRegistrationRouteDeps): RouteHandler<typeof getFederatedRegistrationRoute, CrowiHonoBindings> {
  const { crowi } = deps;
  return async (c) => {
    const { token } = c.req.valid('param');
    try {
      const PendingAuthRegistration = crowi.model('PendingAuthRegistration');
      const row = await PendingAuthRegistration.findByRegistrationGrant(token);
      if (!row) return c.json(GRANT_NOT_FOUND_BODY, 404);
      // AC-2 (grant replay): the spec's snapshot contract is exactly
      // `{email, provider, providerLabel}` — no `status` field (that belongs
      // to the SUBMIT result only, `FederatedRegistrationResultSchema`).
      // `findByRegistrationGrant` returns any non-CANCELLED, non-expired
      // row, which includes a row that already finalized to `ACTIVE`. Once
      // its durable `UserActivation` marker is `done`, the registration has
      // GENUINELY, fully completed — `provisionPendingRegistration` itself
      // already refuses to resume that shape (`not_found`, see
      // `services/auth-registration.ts`'s `resumingActiveRow` check). GET
      // must apply the SAME rule, not just POST: otherwise a grant that has
      // already fully activated stays readable (re-exposing the verified
      // email/provider snapshot) for its entire 24h terminal TTL, an
      // inconsistency with POST's own contract for the identical row.
      if (row.state === 'ACTIVE' && row.userId) {
        const UserActivation = crowi.model('UserActivation');
        const marker = await UserActivation.findOne({ userId: row.userId });
        if (marker?.status === 'done') return c.json(GRANT_NOT_FOUND_BODY, 404);
      }
      return c.json({ email: row.profile.email, provider: row.provider, providerLabel: row.providerLabel }, 200);
    } catch (err) {
      debug('getPendingRegistration failed: %s', (err as Error).message);
      return c.json(INTERNAL_ERROR_BODY, 500);
    }
  };
}

export function submitPendingRegistration(deps: FederatedRegistrationRouteDeps): RouteHandler<typeof submitFederatedRegistrationRoute, CrowiHonoBindings> {
  const { crowi, handoffStore } = deps;
  return async (c) => {
    const { token } = c.req.valid('param');
    const { username } = c.req.valid('json');

    try {
      const outcome = await provisionPendingRegistration(crowi, token, username);
      switch (outcome.kind) {
        case 'not_found':
          return c.json(GRANT_NOT_FOUND_BODY, 404);
        case 'invalid_username':
          return c.json(VALIDATION_ERROR_BODY, 400);
        case 'conflict': {
          const code = outcome.field === 'email' ? ('EMAIL_TAKEN' as const) : ('USERNAME_TAKEN' as const);
          const message = outcome.field === 'email' ? 'Email already registered' : 'Username already taken';
          return c.json({ error: { code, message } }, 409);
        }
        case 'identity_conflict':
          return c.json({ error: { code: 'CONFLICT' as const, message: 'This identity is already linked to a different account' } }, 409);
        case 'approval_required':
          return c.json({ status: 'approval_required' as const }, 200);
        case 'active': {
          // AC-4/AC-8: never return a raw token pair from this endpoint —
          // `token` (this route's own `{token}` path param) reached the
          // browser via a URL redirect from Phase 1's callback, the same
          // leak surface (referrer/history/logs) that motivated Phase 1's
          // OWN sender-constrained handoff for its `code`. Reuse the SAME
          // `FederatedHandoffStore` (shared instance — `hono/index.ts`) so
          // Open-mode success is redeemed through the existing
          // sender-constrained `POST /auth/handoff`, never trusting a
          // leaked registration URL to yield tokens by itself. Bind the
          // code to `outcome.handoffJkt` — the ORIGINAL `/start` sender key
          // this journal row persisted at grant-issuance time
          // (`PendingAuthRegistration.handoffJkt`), never a key this submit
          // request itself supplied: a stolen registration URL alone must
          // not let an attacker rebind the resulting handoff to a key of
          // their own choosing (AC-8).
          const handoffCode = await handoffStore.issue({
            userId: outcome.user._id.toString(),
            handoffJkt: outcome.handoffJkt,
            identityFence: { userId: outcome.user._id.toString(), provider: outcome.identity.provider, providerUserId: outcome.identity.providerUserId },
          });
          return c.json({ status: 'active' as const, code: handoffCode }, 200);
        }
        default: {
          const exhaustive: never = outcome;
          throw new Error(`submitPendingRegistration: unhandled outcome kind ${JSON.stringify(exhaustive)}`);
        }
      }
    } catch (err) {
      debug('submitPendingRegistration failed: %s', (err as Error).message);
      return c.json(INTERNAL_ERROR_BODY, 500);
    }
  };
}

export function logoutPendingRegistration(deps: FederatedRegistrationRouteDeps): RouteHandler<typeof logoutFederatedRegistrationRoute, CrowiHonoBindings> {
  const { crowi } = deps;
  return async (c) => {
    const { token } = c.req.valid('param');
    try {
      const PendingAuthRegistration = crowi.model('PendingAuthRegistration');
      const grantHash = PendingAuthRegistration.hashGrant(token);

      // PENDING/PROVISIONING/APPROVAL_PENDING/ACTIVE rows are all
      // cancellable — the registration screen shows a logout link on every
      // sub-view including the approval-pending one (AC-2 "常時"), and its
      // click must actually, PERMANENTLY invalidate THIS token so a stale
      // tab (or a shared/leaked link) can never again view the status page
      // or replay a submit — not even during the narrow window where the
      // account behind the row has already, genuinely reached ACTIVE but
      // `UserActivation`'s drain (page side effect) hasn't finished yet.
      // Cancelling never touches the underlying User/UserIdentity directly:
      // an ACTIVE or APPROVAL_PENDING row's account already exists (or is
      // REGISTERED/awaiting-approval) and stays exactly as it was — logout
      // only kills this journal row's own bearer token, it never
      // un-registers or deactivates an account.
      //
      // A SINGLE atomic CAS, no compensating re-check afterward — an
      // earlier revision reverted this cancel back to `ACTIVE` (same
      // `grantHash`) whenever it found the User already genuinely active
      // AND the durable activation marker not yet `done`, intending to
      // "preserve resumability". That was a real security bug (AC-2):
      // the SAME, just-invalidated token stayed fully usable through that
      // window — `findByRegistrationGrant`/`beginProvisioning` would
      // happily resume it again, so a "successful" (204) logout did not
      // actually stop a holder of that token from completing the
      // registration and minting a fresh handoff. Resumability of the
      // not-yet-drained window does NOT depend on this row or its grant at
      // all: once `UserIdentity` exists (inserted before the User's own
      // ACTIVE CAS — `services/auth-registration.ts#provisionClaimedRow`),
      // the NEXT IdP re-authentication resolves straight through
      // `createAuthRegistrationTerminal`'s `resolved` identity branch,
      // which drains any not-yet-`done` marker itself, entirely
      // independently of this journal row's `state`/`grantHash`. So there
      // is nothing left for THIS row to stay revertible for — once logout
      // has fired, letting `CANCELLED` stick unconditionally is both the
      // simplest and the only correct behavior: `(CANCELLED journal, ACTIVE
      // user)` is already the accepted terminal pair once the registration
      // has fully finished, and is now equally accepted for the entire
      // window from the moment the User's own ACTIVE CAS commits onward.
      //
      // A concurrent, in-flight submit that has NOT yet reached its OWN
      // ACTIVE CAS is protected by the opposite-direction compensating
      // check in `provisionPendingRegistration` itself
      // (`provisionClaimedRow`'s post-CAS `postCommitRow` re-read, which
      // reverts THAT call's own User CAS if this cancel landed first) — so
      // "logout lands before the account is genuinely active" is still
      // fully covered, just from the other side.
      //
      // ALSO clears `provisioningLeaseExpiresAt`/`provisioningLeaseToken`
      // (AC-2/AC-7 fencing invariant — the SAME reasoning
      // `issueRegistrationGrant`'s FRESH/REVIVE branches already apply on
      // revival, see `models/pending-auth-registration.ts`): an in-flight
      // submit may still hold a LIVE lease at the instant this cancel
      // lands, and `provisionPendingRegistration`'s OWN `userId`-reservation
      // CAS (`{_id, userId: null, provisioningLeaseToken: leaseToken}`) does
      // NOT itself check `state` — it is fenced ONLY on the lease token.
      // Leaving the stale token in place here would let that in-flight
      // submit's reservation write still match (state isn't part of that
      // filter) even though the row is now `CANCELLED`, creating a real
      // `User` for a row that has already been logged out of, before ever
      // reaching a `state`-guarded write. Clearing the lease here closes
      // that gap at its source: any write below this point that is fenced
      // on the (now-cleared) token fails to match immediately, regardless
      // of whether a fresh re-authentication has revived the row yet.
      await PendingAuthRegistration.updateOne(
        { grantHash, state: { $ne: 'CANCELLED' } },
        { $set: { state: 'CANCELLED', expiresAt: terminalExpiry(), provisioningLeaseExpiresAt: null, provisioningLeaseToken: null } },
      );

      return c.body(null, 204);
    } catch (err) {
      debug('logoutPendingRegistration failed: %s', (err as Error).message);
      return c.json(INTERNAL_ERROR_BODY, 500);
    }
  };
}

export const registerFederatedRegistrationRoutes = <E extends OpenAPIHono<CrowiHonoBindings>>(app: E, crowi: Crowi, handoffStore: FederatedHandoffStore) => {
  const deps: FederatedRegistrationRouteDeps = { crowi, handoffStore };

  return app
    .openapi(getFederatedRegistrationRoute, getPendingRegistration(deps))
    .openapi(submitFederatedRegistrationRoute, submitPendingRegistration(deps))
    .openapi(logoutFederatedRegistrationRoute, logoutPendingRegistration(deps));
};
