/**
 * Linking a provider account to an
 * ALREADY signed-in Crowi user, and unlinking it again.
 *
 * The threat this module exists to stop: a link flow that
 * decided its target from anything the callback carries — a query
 * parameter, the IdP profile's email, a client-supplied user id — lets an
 * attacker who gets a victim to open a prepared link URL attach the
 * ATTACKER's IdP identity to the VICTIM's account, which is a permanent
 * backdoor into it. The target is instead fixed at `POST link-start` time
 * from the authenticated web session alone (`hono/handlers/federated-auth.ts`),
 * carried through the IdP round trip as a `LinkCompletionRecord`
 * (`service/link-completion.ts`), and re-verified against a FRESH `User`
 * read right before this module ever runs.
 *
 * Two pieces:
 *
 *  - `createAuthProviderLinkingTerminal` — the confirmation-POST-side link
 *    branch. It only ever inserts `{userId, provider, providerUserId}`; a
 *    duplicate is re-read and reported as either a same-user no-op or an
 *    other-user refusal. It never moves an identity between users — the
 *    `{provider, providerUserId}` unique index is the final defense, and
 *    re-reading the winner is how a concurrent insert is told apart from a
 *    genuine cross-user collision.
 *
 *  - `unlinkFederatedIdentity` — guarded by password availability, never by
 *    counting identities. Counting is what makes "don't remove the last
 *    login method" racy (two concurrent unlinks each see the other's
 *    identity and both proceed); anchoring on "a password still exists"
 *    instead makes the guard a property of a single document that neither
 *    unlink can invalidate (spec design decision 4).
 */

import type Crowi from 'src/crowi';
import { isDisabledPasswordAuth } from 'src/models/config';
import type { UserDocument } from 'src/models/user';
import { isDuplicateKeyError } from 'src/util/map-duplicate-key-error';

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

          // `{userId, provider}` unique — we already have an account of
          // this provider. The exact-subject read above and this slot read are
          // two separate round trips, so the SAME subject's row can land in
          // between: if the slot row's `providerUserId` matches ours, the
          // duplicate-key error was our own concurrent insert winning
          // first, not a genuine conflict, and the retry loop's normal
          // no-op-success case (`already_linked_here`) applies. Only a
          // slot row for a DIFFERENT provider account is a real refusal —
          // never moving or replacing the existing identity.
          const otherAccountOfSameProvider = await UserIdentity.findOne({ userId, provider });
          if (otherAccountOfSameProvider) {
            return otherAccountOfSameProvider.providerUserId === providerUserId ? { kind: 'already_linked_here' } : { kind: 'provider_slot_taken' };
          }

          // Neither row exists any more — retry (see the comment above).
        }
      }
      return { kind: 'failed' };
    },
  };
}

/**
 * Re-derive the
 * outcome an already-consumed `LinkCompletionStore.consumeVerified` replay
 * must report, purely from the DB and the winning record's own
 * `{userId, provider, providerUserId}` (never from a second, independent
 * consume attempt — the code is already spent).
 *
 * Mirrors `createAuthProviderLinkingTerminal`'s two-read shape (exact
 * subject first, provider slot only when the exact read is empty) so the
 * public vocabulary the two paths report is provably the same
 * (§18) — but this is READ-ONLY: no insert, no compensation, no retry.
 */
export type AuthProviderLinkReplayOutcome = { kind: 'linked' | 'owned_by_other_user' | 'provider_slot_taken' | 'not_linked' };

export async function resolveAuthProviderLinkReplay(
  crowi: Crowi,
  input: { userId: string; provider: string; providerUserId: string },
): Promise<AuthProviderLinkReplayOutcome> {
  const UserIdentity = crowi.model('UserIdentity');
  const { userId, provider, providerUserId } = input;

  // Exact subject first — same owner as the winning record means the
  // original insert landed exactly as recorded; a different owner is a
  // genuine (never-identifying) conflict.
  const exactSubject = await UserIdentity.findOne({ provider, providerUserId });
  if (exactSubject) {
    return { kind: String(exactSubject.userId) === String(userId) ? 'linked' : 'owned_by_other_user' };
  }

  // Exact read empty — read the provider slot. If it landed BETWEEN the two
  // reads and carries the SAME `providerUserId` the record was issued for,
  // the original insert has since completed (`linked`); a different
  // subject in that slot is a provider-account conflict; no row at all
  // means the original insert has not landed yet (or never will) —
  // `not_linked`, which a later replay of the SAME code can still resolve
  // to `linked` once the original insert completes (spec design decision 19).
  const providerSlot = await UserIdentity.findOne({ userId, provider });
  if (providerSlot) {
    return { kind: providerSlot.providerUserId === providerUserId ? 'linked' : 'provider_slot_taken' };
  }
  return { kind: 'not_linked' };
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
 * Remove `user`'s identity for `provider` and the journal row it leaves
 * behind, with NO precondition check — callers decide whether removal is
 * allowed (self-service `unlinkFederatedIdentity` below anchors on the
 * password guard; the admin path anchors on its own self/instance-policy
 * rules) and both must go through the exact same removal steps so neither
 * one can reintroduce the f4143f14 regression on its own.
 *
 * Read the identity before removing anything: its `providerUserId` is what
 * keys the registration journal, and the caller only knows
 * `(userId, provider)`.
 */
export async function removeIdentityAndJournal(crowi: Crowi, user: UserDocument, provider: string): Promise<{ removed: boolean }> {
  const UserIdentity = crowi.model('UserIdentity');

  const identity = await UserIdentity.findOne({ userId: user._id, provider });
  if (!identity) return { removed: false };

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
  return { removed: result.deletedCount === 1 };
}

/**
 * Whether the account still has any linked federated identity — the predicate
 * the email-change lock is gated on, in self-service (`handlers/me.ts`) and
 * the admin user routes alike. Both asked it independently before, with
 * different query mechanics, so a future narrowing of what counts as a
 * lock-holding identity had to be found twice.
 *
 * Existence is the right question HERE even though the unlink guard below
 * deliberately refuses to count: this asks "is the address IdP-anchored right
 * now", where losing a race just means the request beat a link/unlink, not
 * that an account was left with no way to sign in.
 */
export async function hasLinkedFederatedIdentity(crowi: Crowi, userId: UserDocument['_id']): Promise<boolean> {
  return (await crowi.model('UserIdentity').exists({ userId })) !== null;
}

/**
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

  const { removed } = await removeIdentityAndJournal(crowi, user, provider);
  return removed ? { kind: 'unlinked' } : { kind: 'not_linked' };
}
