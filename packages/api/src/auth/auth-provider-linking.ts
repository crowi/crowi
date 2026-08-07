/**
 * RFC-0014 phase 3 — linking a provider account to an ALREADY signed-in
 * Crowi user, and unlinking it again.
 *
 * The threat this module exists to stop (spec §背景): a link flow that
 * decided its target from anything the callback carries — a query
 * parameter, the IdP profile's email, a client-supplied user id — lets an
 * attacker who gets a victim to open a prepared link URL attach the
 * ATTACKER's IdP identity to the VICTIM's account, which is a permanent
 * backdoor into it. So the target is fixed at `/start` time from the
 * authenticated web session alone, and every later step only ever
 * re-verifies that same binding.
 *
 * Three pieces:
 *
 *  - `createLinkGrantStore` — the short-lived, server-side-only record the
 *    authenticated `POST .../link-grants` call mints. It holds the caller's
 *    user id, `authVersion`, provider and the phase-1 sender-key
 *    thumbprint; the browser only ever sees an opaque id. Single-use and
 *    30s, because it exists purely to carry the binding across ONE hop
 *    (the `POST` that mints it → the top-level `GET .../start` navigation
 *    that consumes it), not across the IdP round trip: `/start` copies the
 *    binding into the signed state cookie, which is what the callback
 *    re-checks. A 30s window would otherwise be impossible to satisfy —
 *    the user has to actually sign in at the IdP in between.
 *
 *  - `createAuthProviderLinkingTerminal` — the callback-side branch that
 *    runs INSTEAD of phase 2's provisioning whenever the signed state
 *    carries a link target. It only ever inserts `{userId, provider,
 *    providerUserId}`; a duplicate is re-read and reported as either a
 *    same-user no-op or an other-user refusal. It never moves an identity
 *    between users — the `{provider, providerUserId}` unique index is the
 *    final defense, and re-reading the winner is how a concurrent insert
 *    is told apart from a genuine cross-user collision.
 *
 *  - `unlinkFederatedIdentity` — guarded by password availability, never by
 *    counting identities. Counting is what makes "don't remove the last
 *    login method" racy (two concurrent unlinks each see the other's
 *    identity and both proceed); anchoring on "a password still exists"
 *    instead makes the guard a property of a single document that neither
 *    unlink can invalidate (spec design decision 4).
 */

import crypto from 'node:crypto';

import type Crowi from 'src/crowi';
import { isDisabledPasswordAuth } from 'src/models/config';
import type { UserDocument } from 'src/models/user';
import { isDuplicateKeyError } from 'src/util/map-duplicate-key-error';
import type { RedisKeyspace } from 'src/util/redis-keyspace';

/** Spec §契約: the link grant covers ONE hop (mint → start), not the IdP round trip — see the module doc comment. */
const LINK_GRANT_TTL_MS = 30 * 1000;
const GRANT_ID_BYTES = 32;

/**
 * The server-side-only binding a link flow is pinned to. Every field is
 * re-checked at `/start`; `userId`/`authVersion` are re-checked once more
 * at callback time (carried there in the signed state cookie), so a
 * session invalidated mid-flow — a password reset, a forced sign-out —
 * links nothing.
 */
export interface LinkGrant {
  userId: string;
  provider: string;
  /**
   * `User.authVersion` at mint time. Bumped by password reset / email
   * change / forced revocation, so a stale grant from a session that has
   * since been invalidated cannot complete a link.
   */
  authVersion: number;
  /**
   * RFC 7638 thumbprint of the phase-1 sender key this flow is bound to —
   * the same value `/start` derives from its own `handoff_jwk` query
   * parameter. A stolen link URL replayed in a DIFFERENT browser carries
   * that browser's own key, so the thumbprints differ and `/start`
   * refuses (AC-2).
   */
  handoffChallenge: string;
}

export interface LinkGrantStore {
  /** Mint an opaque, single-use grant id for `grant`. */
  issue(grant: LinkGrant): Promise<string>;
  /**
   * Atomically consume `grantId`. Returns the grant only for the FIRST
   * caller — a replayed id (a second tab, an attacker re-using an
   * intercepted `/start` URL) gets `null`, exactly like an unknown or
   * expired one. Callers cannot distinguish those cases and must not try.
   */
  consume(grantId: string): Promise<LinkGrant | null>;
}

/** Minimal node-redis v4 surface — same narrow-by-design convention as `service/federated-handoff.ts`. */
export interface MinimalLinkGrantRedisClient {
  set(key: string, value: string, options: { PX: number }): Promise<unknown>;
  getDel(key: string): Promise<string | null>;
}

function parseGrant(raw: string | null | undefined): LinkGrant | null {
  if (raw == null) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<LinkGrant>;
    if (
      typeof parsed.userId !== 'string' ||
      typeof parsed.provider !== 'string' ||
      typeof parsed.authVersion !== 'number' ||
      typeof parsed.handoffChallenge !== 'string'
    ) {
      return null;
    }
    return { userId: parsed.userId, provider: parsed.provider, authVersion: parsed.authVersion, handoffChallenge: parsed.handoffChallenge };
  } catch {
    return null;
  }
}

export interface CreateLinkGrantStoreOptions {
  /** Pass `crowi.redis`. `null`/`undefined` → in-memory fallback (single instance / dev). */
  redisClient?: MinimalLinkGrantRedisClient | null;
  /** MANDATORY whenever `redisClient` is supplied (same convention as `service/federated-handoff.ts`). */
  keyspace?: RedisKeyspace;
}

export function createLinkGrantStore(options: CreateLinkGrantStoreOptions = {}): LinkGrantStore {
  const { redisClient, keyspace } = options;

  if (redisClient) {
    if (!keyspace) {
      throw new Error(
        'createLinkGrantStore: `keyspace` is required whenever `redisClient` is supplied (feature-redis-key-prefix §1/§2) — resolve one via resolveRedisKeyspaceIfEnabled(crowi) before constructing the store.',
      );
    }
    const keyFor = (grantId: string) => keyspace.key('auth-link-grant', grantId);
    return {
      async issue(grant) {
        const grantId = crypto.randomBytes(GRANT_ID_BYTES).toString('base64url');
        await redisClient.set(keyFor(grantId), JSON.stringify(grant), { PX: LINK_GRANT_TTL_MS });
        return grantId;
      },
      async consume(grantId) {
        // `GETDEL` is the read and the single-use consume in ONE command —
        // a separate GET + DEL would let two concurrent replays both read
        // the grant before either deleted it.
        return parseGrant(await redisClient.getDel(keyFor(grantId)));
      },
    };
  }

  const store = new Map<string, { grant: LinkGrant; expiresAt: number }>();
  return {
    async issue(grant) {
      const grantId = crypto.randomBytes(GRANT_ID_BYTES).toString('base64url');
      const now = Date.now();
      for (const [key, entry] of store) {
        if (entry.expiresAt <= now) store.delete(key);
      }
      store.set(grantId, { grant, expiresAt: now + LINK_GRANT_TTL_MS });
      return grantId;
    },
    async consume(grantId) {
      // Read-and-delete with no `await` in between, so nothing can
      // interleave — the same single-threaded-event-loop argument
      // `service/federated-handoff.ts`'s in-memory backend documents.
      const entry = store.get(grantId);
      store.delete(grantId);
      if (!entry || entry.expiresAt <= Date.now()) return null;
      return entry.grant;
    },
  };
}

/**
 * Outcome of linking an identity to an already-authenticated user.
 *
 * `already_linked_here` is deliberately a SUCCESS: re-linking an account
 * the user has already linked is the same end state they asked for, and
 * reporting it as an error would turn an idempotent retry (a double-click,
 * a back-button re-submit) into a scary failure.
 *
 * `owned_by_other_user` never says WHO owns it — that would turn the link
 * endpoint into an oracle for "does this Google account have a Crowi
 * account here", which is exactly the kind of cross-account disclosure the
 * spec's error semantics forbid.
 */
export type LinkFederatedIdentityOutcome =
  | { kind: 'linked' }
  | { kind: 'already_linked_here' }
  | { kind: 'owned_by_other_user' }
  /** This user already has a DIFFERENT account of the same provider linked (umbrella: one identity per provider per user). Distinct from `owned_by_other_user` so logs and tests stay precise, though both refuse. */
  | { kind: 'provider_slot_taken' }
  /** Could not complete — a concurrent unlink kept removing the row this insert collided with. Never reported as a conflict, because nothing is actually conflicting. */
  | { kind: 'failed' };

export interface AuthProviderLinkingTerminal {
  link(input: { userId: string; provider: string; providerUserId: string }): Promise<LinkFederatedIdentityOutcome>;
}

/**
 * The callback-side link branch. Never reads the profile's email, never
 * consults registration mode / whitelist, never creates a `User` — a link
 * targets an account that already exists and is already signed in.
 */
export function createAuthProviderLinkingTerminal(crowi: Crowi): AuthProviderLinkingTerminal {
  return {
    async link({ userId, provider, providerUserId }) {
      const UserIdentity = crowi.model('UserIdentity');

      // Two attempts. A duplicate-key error is never trusted on its own —
      // it says only "some unique index rejected this", so the actual state
      // is re-read to tell the three real cases apart. The re-read can also
      // find NOTHING, when a concurrent unlink removed the very row this
      // insert collided with; that is not a conflict at all (reporting it
      // as one would tell users their OWN account is taken by someone
      // else), so the insert is simply retried. One retry terminates: the
      // second attempt either wins outright or collides with a row that is
      // still there to be read.
      for (let attempt = 0; attempt < 2; attempt += 1) {
        try {
          await UserIdentity.create({ userId, provider, providerUserId });
          return { kind: 'linked' };
        } catch (err) {
          if (!isDuplicateKeyError(err)) throw err;

          // `{provider, providerUserId}` unique — someone holds this exact
          // provider account. Ours (a double-submitted callback) is a no-op
          // success; anyone else's is a refusal that never names them.
          const sameAccount = await UserIdentity.findOne({ provider, providerUserId });
          if (sameAccount) {
            return String(sameAccount.userId) === String(userId) ? { kind: 'already_linked_here' } : { kind: 'owned_by_other_user' };
          }

          // `{userId, provider}` unique — we already have a DIFFERENT
          // account of this provider. Refused without ever moving or
          // replacing the existing identity.
          const otherAccountOfSameProvider = await UserIdentity.findOne({ userId, provider });
          if (otherAccountOfSameProvider) return { kind: 'provider_slot_taken' };

          // Neither row exists any more — retry (see the comment above).
        }
      }
      return { kind: 'failed' };
    },
  };
}

/**
 * Unlink outcome. `password_required` covers BOTH guard failures on
 * purpose — "password auth is disabled instance-wide" and "you personally
 * have no password set" are the same actionable answer to the caller
 * ("you'd have no way back in"), and distinguishing them leaks instance
 * configuration to an endpoint that does not need to expose it. The
 * handler maps the disabled-instance case to its own error code because
 * that one IS fixed instance policy the user cannot act on.
 */
export type UnlinkFederatedIdentityOutcome = { kind: 'unlinked' } | { kind: 'not_linked' } | { kind: 'password_auth_disabled' } | { kind: 'password_required' };

/**
 * Remove `user`'s identity for `provider`.
 *
 * The guard never counts identities (spec design decision 4). Counting is
 * what makes "don't strand the account" racy: two concurrent unlinks each
 * see the other's identity still present and both proceed, leaving an
 * account with no login method at all. Anchoring on the password instead
 * makes the guard depend on a document neither unlink touches — if
 * password auth is on and a password is set, that path survives any number
 * of concurrent unlinks; if password auth is off, no unlink is ever
 * allowed in the first place.
 */
export async function unlinkFederatedIdentity(crowi: Crowi, user: UserDocument, provider: string): Promise<UnlinkFederatedIdentityOutcome> {
  const UserIdentity = crowi.model('UserIdentity');

  if (isDisabledPasswordAuth(crowi.getConfig())) {
    return { kind: 'password_auth_disabled' };
  }

  // `populateSecrets()` before `isPasswordSet()` — the password hash is
  // deliberately not on the ordinary `User` projection (same two-step
  // `handlers/me.ts` uses before every password-sensitive decision).
  const userWithSecrets = await user.populateSecrets();
  if (!userWithSecrets.isPasswordSet()) {
    return { kind: 'password_required' };
  }

  // Read the identity before removing anything: its `providerUserId` is
  // what keys the registration journal, and the caller only knows
  // `(userId, provider)`.
  const identity = await UserIdentity.findOne({ userId: user._id, provider });
  if (!identity) return { kind: 'not_linked' };

  // The journal row goes FIRST, and it has to go at all.
  //
  // A finalized `PendingAuthRegistration` for this provider subject
  // outlives the identity, and `createAuthRegistrationTerminal`'s resume
  // branch treats any non-fresh row as "an interrupted registration to
  // continue" — handing back a grant bound to its `userId` WITHOUT the
  // registration-mode or email-collision gates. Left behind, it is a
  // standing credential: the same provider account signs in again,
  // reaches the registration screen because the identity is gone, and
  // walks straight back into the account the unlink was supposed to
  // revoke. That is exactly what manual QA hit (2026-08-07).
  //
  // The terminal cannot tell that case apart from a genuine crash-resume
  // (both are an ACTIVE row with a `userId` and no `UserIdentity`), so
  // the fix belongs here, where the difference is known: an identity
  // existed, therefore the registration ran to completion, therefore no
  // legitimate resume can be destroyed by dropping its journal row.
  //
  // Ordered before the identity delete so a crash between the two leaves
  // the account linked and working rather than unlinked-but-reacquirable
  // — the failure that still has to be safe is the one that leaves the
  // hole open.
  await crowi.model('PendingAuthRegistration').deleteOne({ provider, providerUserId: identity.providerUserId });

  const result = await UserIdentity.deleteOne({ _id: identity._id });
  return result.deletedCount === 1 ? { kind: 'unlinked' } : { kind: 'not_linked' };
}
