/**
 * RFC-0014 phase 2 — federated registration screen + JIT provisioning.
 *
 * Two responsibilities:
 *
 *  - `createAuthRegistrationTerminal(crowi)` — the `FederatedProfileTerminal`
 *    Phase 1's callback (`hono/handlers/federated-auth.ts`) invokes for
 *    EVERY resolved federated profile. It does the identity lookup itself:
 *    an existing `UserIdentity` resolves straight through Phase 1's own
 *    handoff path (`{kind: 'resolved', user}`); an unknown identity mints a
 *    `PendingAuthRegistration` grant and redirects to the registration
 *    screen (`{kind: 'registration', token}`) instead of ever creating a
 *    `User`. Registration-mode gating (Closed / whitelist) and the
 *    "existing local email → no auto-link" rule (RFC-0014 §5.4) both live
 *    here, at the same point token-auth.ts's password registration applies
 *    them (`hono/handlers/token-auth.ts:141-151`).
 *
 *  - `provisionPendingRegistration` — the grant-submit state machine (design
 *    decision 3): resumable from `PendingAuthRegistration.userId` and each
 *    downstream document's own unique index, no multi-document transaction.
 *    `drainUserActivation` / `ensureUserPage` are the durable activation-time
 *    side effect (design decision 4), reused by both the Open-mode direct
 *    call below and the `'activated'` event listener
 *    (`events/user.ts#onActivated`, Restricted → admin-approval path).
 */

import { UsernameSchema } from '@crowi/api-contract';
import { Types } from 'mongoose';
import type { FederatedProfileTerminal, FederatedProfileTerminalRequest, FederatedProfileTerminalResult } from 'src/auth/federated-profile-terminal';
import type Crowi from 'src/crowi';
import { type PendingAuthRegistrationDocument, TERMINAL_TTL_MS } from 'src/models/pending-auth-registration';
import { USER_UNIQUE_COLLATION, type UserDocument, type UserModel } from 'src/models/user';
import type { UserIdentityModel } from 'src/models/user-identity';
import { isDuplicateKeyError, mapDuplicateKeyError } from 'src/util/map-duplicate-key-error';

/**
 * `drainUserActivation`'s durable side effect: the user's wiki page exists
 * (created here, or already present — never renamed, never duplicated).
 * Mirrors `events/user.ts#createUserPage` but WITHOUT the legacy
 * rename-and-recreate branch (design decision 4 — JIT path never renames a
 * pre-existing manual page).
 */
export async function ensureUserPage(crowi: Crowi, user: UserDocument): Promise<void> {
  const Page = crowi.model('Page');
  const userPagePath = Page.getUserPagePath(user);

  const existing = await Page.findPage(userPagePath, user, undefined, true);
  if (existing) return;

  try {
    await Page.createPage(userPagePath, `# ${user.username}\nThis is ${user.username}'s page`, user, {});
  } catch (err) {
    // Duplicate/conflict race (another drain, or the legacy listener, won
    // first) — re-check for idempotent success instead of surfacing.
    const reloaded = await Page.findPage(userPagePath, user, undefined, true);
    if (reloaded) return;
    throw err;
  }
}

/**
 * `drainUserActivation`'s result: `'done'` means the marker is genuinely,
 * durably `done` — either THIS call ran the side effect and marked it so,
 * or it found the marker already `done` from a prior run. `'holding'` means
 * neither: another caller currently holds a LIVE lease on the marker (a
 * genuinely concurrent drain still running, OR a prior attempt that crashed
 * mid-side-effect and whose lease has not yet lapsed — indistinguishable
 * from here), so this call could not confirm completion. Callers MUST NOT
 * treat `'holding'` as success (see `provisionClaimedRow`'s use below).
 */
export type UserActivationDrainResult = 'done' | 'holding';

/**
 * CAS-claim + run + mark-done the durable activation marker for `userId`.
 * A no-op when the marker is already `done` or another caller holds a live
 * lease — safe to call from multiple sites (design decision 4).
 */
export async function drainUserActivation(crowi: Crowi, userId: Types.ObjectId | string): Promise<UserActivationDrainResult> {
  const UserActivation = crowi.model('UserActivation');
  const claimed = await UserActivation.claimActivationLease(userId);
  if (claimed) {
    const User = crowi.model('User');
    const user = (await User.findById(userId)) as UserDocument | null;
    if (user) {
      await ensureUserPage(crowi, user);
    }
    await UserActivation.markActivationDone(userId);
    return 'done';
  }

  // Didn't claim: `claimActivationLease` returns `null` for BOTH a `done`
  // marker AND a live `running` lease held by someone else — re-read the
  // marker to tell them apart. Only a genuinely `done` marker is safe to
  // report as complete.
  const marker = await UserActivation.findOne({ userId });
  return marker?.status === 'done' ? 'done' : 'holding';
}

/**
 * The `FederatedProfileTerminal` Phase 1's callback always invokes. Looks up
 * an existing identity first (Phase 1's ordinary handoff path); on a miss,
 * applies registration-mode/whitelist/email-collision gates and mints a
 * `PendingAuthRegistration` grant.
 */
export function createAuthRegistrationTerminal(crowi: Crowi): FederatedProfileTerminal {
  return {
    async resolve(request: FederatedProfileTerminalRequest): Promise<FederatedProfileTerminalResult> {
      const { provider, profile, providerLabel, handoffJkt } = request;
      const UserIdentity = crowi.model('UserIdentity');
      const User = crowi.model('User');
      const Config = crowi.model('Config');
      const PendingAuthRegistration = crowi.model('PendingAuthRegistration');

      // Shared by every `{kind: 'registration'}` exit below — only the
      // email varies (the identity-branch resume keeps the User's existing
      // email rather than a possibly-changed IdP claim; every other path
      // uses the profile's own verified email).
      const issueGrant = async (email: string): Promise<FederatedProfileTerminalResult> => {
        const token = await PendingAuthRegistration.issueRegistrationGrant({
          provider,
          providerUserId: profile.providerUserId,
          providerLabel,
          profile: { email, name: profile.name, imageUrl: profile.imageUrl },
          handoffJkt,
        });
        return { kind: 'registration', token };
      };

      const identity = await UserIdentity.findOne({ provider, providerUserId: profile.providerUserId });
      if (identity) {
        const user = (await User.findById(identity.userId)) as UserDocument | null;
        if (user) {
          if (user.status === User.STATUS_ACTIVE) {
            // Re-authenticating via the IdP is ALSO a valid recovery path
            // for a crash between the User's ACTIVE CAS and its
            // activation-time page side effect (design decision 4 —
            // "callback 再開が drain を再試行する"): once the identity
            // exists AND the user is genuinely active, this profile always
            // resolves straight through here, so
            // `provisionPendingRegistration` itself can no longer be
            // reached to retry the drain. A durable marker that hasn't
            // reached `done` yet is drained here, before the ordinary
            // resolved handoff continues — and, mirroring
            // `provisionClaimedRow`'s OWN handling of this exact shape
            // below, a `'holding'` result (another caller currently holds
            // the live lease — a genuinely concurrent drain, or a PRIOR
            // attempt that crashed mid-side-effect whose lease hasn't
            // lapsed yet; indistinguishable from here) must NOT be treated
            // as success. Resolving straight through regardless would
            // silently strand the marker: the browser would receive an
            // ordinary signed-in session and never retry, and nothing else
            // re-triggers `drainUserActivation` until either a fresh IdP
            // re-authentication (this SAME branch) or a resubmit (already
            // unreachable — the identity exists) happens. Throwing here
            // (caught by Hono's global error handler -> 500) is the spec's
            // own contract for this shape ("crash/temporary DB error は
            // 500 とし grant を取消さず retry 可能にする"): nothing durable
            // is rolled back, and a retried re-authentication resumes via
            // this SAME branch once the lease legitimately lapses.
            const UserActivation = crowi.model('UserActivation');
            const marker = await UserActivation.findOne({ userId: user._id });
            if (marker && marker.status !== 'done') {
              const drainResult = await drainUserActivation(crowi, user._id);
              if (drainResult !== 'done') {
                throw new Error(
                  `createAuthRegistrationTerminal: activation-time page side effect for User ${String(user._id)} could not be confirmed complete on re-auth (drain result: ${drainResult})`,
                );
              }
            }
            return { kind: 'resolved', user };
          }
          // AC-3: the identity is linked but the User never finished
          // activating — either a crash landed between `ensureIdentityLink`
          // and the User's own ACTIVE CAS in `provisionPendingRegistration`
          // (Open mode), or the row is legitimately `APPROVAL_PENDING`
          // (Restricted mode, `user.status` also stays REGISTERED while
          // awaiting admin approval). Resolving straight through as
          // `{kind:'resolved', user}` here would hand the caller a
          // REGISTERED user, and `completeFederatedCallback` maps any
          // non-ACTIVE resolved user to a dead-end `account_inactive`
          // redirect with no way to finish or even check status — the
          // grant token from the original attempt is gone once the browser
          // navigated away. Re-issue a grant on the SAME journal row
          // instead: `issueRegistrationGrant` already resumes a
          // PROVISIONING/APPROVAL_PENDING row by its existing `userId` and
          // `state` (never creates a second journal row for this
          // provider identity), so re-authenticating naturally resumes the
          // SAME in-flight provisioning or re-opens the SAME approval-
          // pending status page.
          return issueGrant(user.email);
        }
        // Orphan identity row (its User was deleted) — no safe resolution.
        return { kind: 'redirect_error', code: 'registration_unavailable' };
      }

      const email = profile.email;
      if (!email) {
        // Phase 0/1's driver contract already rejects a missing/unverified
        // email before a profile ever reaches this terminal (umbrella spec
        // "全フェーズに共通する確定事項") — this is a defensive backstop, not
        // an expected path.
        return { kind: 'redirect_error', code: 'registration_unavailable' };
      }

      // AC-3/AC-5: resuming an in-flight (or already-decided) journal row
      // for this SAME `{provider, providerUserId}` must not re-run the
      // fresh-registration gates below. `UserIdentity.findOne` above only
      // finds a row once `ensureIdentityLink` has actually run — a crash
      // strictly AFTER `provisionPendingRegistration` reserves/creates the
      // User but BEFORE it inserts the `UserIdentity` row lands right here,
      // and the "no auto-link" email-collision check further down would
      // otherwise find that VERY User (created by this row's own earlier
      // attempt) and wrongly reject the resume as `email_already_registered`
      // — a re-authenticated visitor could never recover. Only a row that
      // has reserved NO `userId` at all — `PENDING` (never submitted), or
      // `CANCELLED` with `userId: null` (cancelled before
      // `provisionPendingRegistration` ever reserved one) — has genuinely
      // created nothing yet and safely falls through to the fresh gates
      // below (`issueRegistrationGrant`'s own FRESH branch resets it). A
      // `CANCELLED` row that DOES carry a `userId` (a logout, or a submit's
      // own AC-2 compensating revert, landing AFTER a real `User` was
      // already created for this row — e.g. crash between User creation
      // and the `UserIdentity` insert, combined with a concurrent logout)
      // must resume via `issueGrant` -> `issueRegistrationGrant`'s REVIVE
      // branch instead: falling through to the fresh gates here would run
      // the email-collision check against that VERY User and wrongly,
      // permanently reject the resume the same way the crash-only case
      // above would.
      const existingRow = await PendingAuthRegistration.findOne({ provider, providerUserId: profile.providerUserId });
      const isFreshEligible = !existingRow || existingRow.state === 'PENDING' || (existingRow.state === 'CANCELLED' && existingRow.userId == null);
      if (!isFreshEligible) {
        return issueGrant(email);
      }

      const config = (await Config.loadAllConfig()) as { crowi: Record<string, unknown> };
      if (config.crowi['security:registrationMode'] === Config.SECURITY_REGISTRATION_MODE_CLOSED) {
        return { kind: 'redirect_error', code: 'registration_closed' };
      }
      if (!User.isEmailValid(email)) {
        return { kind: 'redirect_error', code: 'email_not_allowed' };
      }

      // No auto-link (RFC-0014 §5.4 / umbrella "やらないこと"): an email
      // already owned by a local account is a login error, never a merge.
      // Case-insensitive (`USER_UNIQUE_COLLATION`), matching the `User.email`
      // unique index's own collation (`models/user.ts`) — a plain
      // case-sensitive query here would miss a case-only-different existing
      // account and let this profile reach the registration screen instead
      // of the "already registered" redirect. Passed as a query OPTION
      // (3rd `findOne` arg) rather than the chained `.collation()` method —
      // functionally identical, but keeps this call compatible with tests
      // that stub `User.findOne` as a plain async function.
      const existingByEmail = await User.findOne({ email }, null, { collation: USER_UNIQUE_COLLATION });
      if (existingByEmail) {
        return { kind: 'redirect_error', code: 'email_already_registered' };
      }

      return issueGrant(email);
    },
  };
}

export type ProvisionPendingRegistrationOutcome =
  | { kind: 'not_found' }
  | { kind: 'invalid_username' }
  | { kind: 'conflict'; field: 'username' | 'email' }
  | { kind: 'identity_conflict' }
  /** `handoffJkt` is the row's OWN persisted value (`PendingAuthRegistration.handoffJkt` — see that model's doc comment), never a value the submit request itself supplied (AC-8). */
  | {
      kind: 'active';
      user: UserDocument;
      handoffJkt: string;
      /** RFC-0014 phase 3 (AC-7) — the identity this registration just created, pinned into the handoff so an unlink before redemption revokes the pending code. */
      identity: { provider: string; providerUserId: string };
    }
  | { kind: 'approval_required' };

/**
 * The grant-submit state machine (design decision 3 / flow steps 4-8).
 * Resumable: re-invoking with the same (still-valid) grant after a crash at
 * any step continues from `PendingAuthRegistration.userId` and each
 * downstream document's own unique index — never creates a second `User` or
 * `UserIdentity` for the same journal row.
 */
export async function provisionPendingRegistration(crowi: Crowi, grant: string, username: string): Promise<ProvisionPendingRegistrationOutcome> {
  const PendingAuthRegistration = crowi.model('PendingAuthRegistration');

  const grantHash = PendingAuthRegistration.hashGrant(grant);
  // AC-7: `beginProvisioning` also claims a single-flight lease on `row._id`
  // — `null` here covers both "unknown/expired/wrong-state grant" AND "a
  // concurrent call for this SAME grant currently holds the lease" (the
  // single-winner case: the other caller wins, this one is rejected the
  // same way an unknown grant would be). MUST release the lease in
  // `finally` below on every exit from this point on so a legitimate serial
  // retry never waits out the full lease TTL. `leaseToken` fences every
  // write below this call makes that depends on still being the exclusive
  // holder — see `PendingAuthRegistrationModel.beginProvisioning`'s JSDoc.
  const row = await PendingAuthRegistration.beginProvisioning(grantHash);
  if (!row) {
    // AC-8: a Restricted-mode registration that ALREADY finalized to
    // `APPROVAL_PENDING` is deliberately NOT resumable by
    // `beginProvisioning` — spec flow step 4 matches only
    // `PENDING`/`PROVISIONING`, and a finalized row must never be
    // re-provisioned. But collapsing it into the same `not_found` as an
    // unknown/expired grant makes "waiting for an admin" visually
    // indistinguishable from "your link expired" the moment the visitor
    // reloads the page (or re-authenticates through the IdP): the approval
    // card is otherwise rendered ONLY from the original submit's response,
    // which a reload discards. Re-report the status instead — a pure read
    // of a row this same grant already owns: no lease claimed, no state
    // changed, no token issued, exactly what that first submit already told
    // this very grant holder. `findByRegistrationGrant` applies the same
    // CANCELLED/expiry exclusions as everywhere else, so an expired or
    // cancelled row still falls through to `not_found`.
    const finalized = await PendingAuthRegistration.findByRegistrationGrant(grant);
    if (finalized?.state === 'APPROVAL_PENDING') return { kind: 'approval_required' };
    return { kind: 'not_found' };
  }
  const leaseToken = row.provisioningLeaseToken;
  if (!leaseToken) {
    // Defensive — `beginProvisioning` always sets this together with
    // `provisioningLeaseExpiresAt` on every claim/reclaim; never expected.
    throw new Error(`provisionPendingRegistration: beginProvisioning returned row ${String(row._id)} with no provisioningLeaseToken`);
  }

  try {
    return await provisionClaimedRow(crowi, row, username, leaseToken);
  } finally {
    await PendingAuthRegistration.releaseProvisioningLease(row._id, leaseToken);
  }
}

async function provisionClaimedRow(
  crowi: Crowi,
  row: PendingAuthRegistrationDocument,
  username: string,
  leaseToken: string,
): Promise<ProvisionPendingRegistrationOutcome> {
  const PendingAuthRegistration = crowi.model('PendingAuthRegistration');
  const User = crowi.model('User');
  const UserIdentity = crowi.model('UserIdentity');
  const Config = crowi.model('Config');
  const UserActivation = crowi.model('UserActivation');

  // `beginProvisioning` also resumes an already-finalized ACTIVE row (see
  // its JSDoc) — legitimate ONLY while the activation-time page side
  // effect hasn't completed yet (AC-5/AC-6: a crash between the journal's
  // ACTIVE write, the User's own ACTIVE CAS, and `ensureUserPage` must
  // stay resumable via the SAME grant). Once `UserActivation`'s marker for
  // this row's `userId` is `done`, the registration genuinely finished —
  // a further resubmit must not become a standing bearer credential a
  // leaked URL could replay for a fresh token pair within its remaining
  // 24h TTL.
  const resumingActiveRow = row.state === 'ACTIVE';
  if (resumingActiveRow) {
    const marker = row.userId ? await UserActivation.findOne({ userId: row.userId }) : null;
    if (marker?.status === 'done') return { kind: 'not_found' };
  }

  const parsedUsername = UsernameSchema.safeParse(username);
  if (!parsedUsername.success) return { kind: 'invalid_username' };

  let userId = row.userId;
  if (!userId) {
    // Reserve a creation slot in the journal BEFORE ever touching `User`
    // (AC-5): this CAS is the exactly-once claim, and it makes the User
    // creation below resumable BY ID rather than by content
    // (email/username) — a crash between this reservation and
    // `newUser.save()` left NO trace the old content-based check could
    // distinguish from a genuine external email/username conflict on
    // retry. With the id reserved first, a retry's `User.findById(userId)`
    // unambiguously answers "did I already create this one".
    //
    // Fenced on `leaseToken` (AC-2/AC-8 — same reasoning as the two
    // finalize writes below): `row.userId` was observed `null` at the time
    // `beginProvisioning` returned, but this write can still run AFTER a
    // concurrent logout + fresh re-authentication revives the row back to
    // `PENDING`/`userId: null` (`issueRegistrationGrant`'s FRESH branch —
    // `models/pending-auth-registration.ts`), which now ALSO clears the
    // lease. Without this fence, a logged-out OLD submit could still win
    // this CAS purely because `userId` happens to be `null` again, creating
    // a phantom `User`/`UserIdentity` for a row a fresh attempt just reset —
    // orphaned from (and silently clobbering the username of) the
    // legitimately re-authenticated visitor's own subsequent submit.
    const candidateId = new Types.ObjectId();
    const claimed = await PendingAuthRegistration.findOneAndUpdate(
      { _id: row._id, userId: null, provisioningLeaseToken: leaseToken },
      { $set: { userId: candidateId } },
    );
    if (claimed) {
      userId = candidateId;
    } else {
      const fresh = await PendingAuthRegistration.findById(row._id);
      if (fresh?.provisioningLeaseToken !== leaseToken) {
        // Fenced out: our lease no longer holds (cleared/reclaimed by the
        // race above, or any other concurrent writer) — never fabricate a
        // `userId` or touch `User`/`UserIdentity` for a row we no longer
        // own.
        return { kind: 'not_found' };
      }
      // Another call under this SAME still-current lease already reserved
      // a slot (defensive — AC-7's single-flight lease should make this
      // unreachable in practice) — resume with ITS id.
      userId = fresh.userId ?? candidateId;
    }
  }

  // Idempotent regardless of whether `userId` was just reserved above or
  // came from a prior attempt (reserved-but-not-created, or fully created
  // already) — `createUserForRegistration` always resolves to "the User
  // for this id exists" before returning.
  const createResult = await createUserForRegistration(User, userId, row, parsedUsername.data);
  if (createResult.kind !== 'ok') return createResult;

  const identityOutcome = await ensureIdentityLink(UserIdentity, row, userId);
  if (identityOutcome !== 'ok') {
    // AC-7: this journal row can never converge for this provider identity —
    // it is PERMANENTLY owned by a DIFFERENT account (no auto-link, RFC-0014
    // §5.4). The `User` just created/verified above for THIS row's reserved
    // `userId` has no identity link, no page, and no activation marker yet —
    // nothing else in the system references it. Left behind, it would
    // permanently squat the chosen username/email for an account that can
    // never sign in (no password, no linked identity). Delete it so the
    // conflict doesn't leak a resource: idempotent regardless of whether
    // `createUserForRegistration` created it fresh this call or merely
    // resumed it from a prior attempt — any retry of this SAME grant
    // reserves the SAME `userId` (`row.userId`, unchanged) and recreates it.
    await User.deleteOne({ _id: userId, status: User.STATUS_REGISTERED });
    return { kind: 'identity_conflict' };
  }

  await UserActivation.ensurePendingMarker(userId);

  // A row already finalized to ACTIVE sticks to that decision on resume,
  // regardless of whether the live registration mode has since changed
  // (an admin flipping Open→Restricted mid-recovery must not downgrade an
  // in-flight activation back to APPROVAL_PENDING) — so the live config is
  // never even read on that resume path.
  let isRestricted = false;
  if (!resumingActiveRow) {
    const config = (await Config.loadAllConfig()) as { crowi: Record<string, unknown> };
    isRestricted = config.crowi['security:registrationMode'] === Config.SECURITY_REGISTRATION_MODE_RESTRICTED;
  }

  if (isRestricted) {
    // Guarded against a concurrent logout (AC-2 security): if the grant was
    // CANCELLED between `beginProvisioning` above and here, this update
    // matches nothing and the row STAYS cancelled — a cancelled
    // registration must never be reported as `approval_required`. Also
    // fenced on `leaseToken` (AC-7): if this call's lease was silently
    // reclaimed by a NEW caller (it overran the 30s window), its token no
    // longer matches the document's current one and this finalize write
    // matches nothing either — a fenced-out caller can never complete the
    // state machine even though the `state !== 'CANCELLED'` condition alone
    // would still have matched.
    const finalized = await PendingAuthRegistration.updateOne(
      { _id: row._id, state: { $ne: 'CANCELLED' }, provisioningLeaseToken: leaseToken },
      { $set: { state: 'APPROVAL_PENDING', userId, expiresAt: terminalExpiry() } },
    );
    if (finalized.matchedCount === 0) return { kind: 'not_found' };
    return { kind: 'approval_required' };
  }

  // Same guards, checked BEFORE the User's own ACTIVE CAS (not after, as a
  // cosmetic journal write): a concurrent logout must actually be able to
  // prevent activation, not just get silently overwritten by this submit's
  // own unconditional finalize (AC-2 security — the prior version of this
  // finalize ran unconditionally and could resurrect a CANCELLED row), and a
  // fenced-out (lease-reclaimed) caller must not be able to activate either
  // (AC-7 — see the `isRestricted` branch's comment above for the same
  // `provisioningLeaseToken` fencing).
  //
  // `expiresAt` is only (re)set to a FRESH 24h on a genuinely FIRST
  // completion (`!resumingActiveRow`) — a RESUME (the row was already
  // `ACTIVE` when `beginProvisioning` returned it) leaves the existing
  // `expiresAt` untouched. `beginProvisioning` itself now enforces that
  // expiry on every resume attempt (see its own JSDoc); repeatedly
  // extending it here on every resume would defeat that enforcement by
  // turning a 24h-bounded grant into an effectively unbounded bearer
  // credential whenever the activation marker never reaches `done`.
  const finalized = await PendingAuthRegistration.updateOne(
    { _id: row._id, state: { $ne: 'CANCELLED' }, provisioningLeaseToken: leaseToken },
    { $set: { state: 'ACTIVE', userId, ...(resumingActiveRow ? {} : { expiresAt: terminalExpiry() }) } },
  );
  if (finalized.matchedCount === 0) return { kind: 'not_found' };

  // CAS: matches (and flips) a still-REGISTERED user exactly once. A
  // resumed call whose prior attempt already won this CAS matches zero
  // documents — harmless, `reloaded` below still reflects the
  // (already-ACTIVE) user.
  const userCas = await User.updateOne({ _id: userId, status: User.STATUS_REGISTERED }, { $set: { status: User.STATUS_ACTIVE } });

  // AC-2 (security): a logout can still land in the gap between the
  // journal write above and this User CAS — MongoDB gives no
  // cross-collection atomicity without a multi-document transaction, which
  // the umbrella spec forbids. Close it with a COMPENSATING check instead
  // of merely narrowing the window: re-read the journal one more time, and
  // if a concurrent logout cancelled it in that gap, revert the User CAS
  // THIS call itself performed (never someone else's — `userCas.modifiedCount
  // === 1` is only true for the CAS this invocation won) so a CANCELLED
  // journal can never coexist with an ACTIVE User — the exact invariant the
  // caller's handoff issuance depends on. `logoutPendingRegistration` itself
  // runs a plain, unconditional CAS with no compensating revert of its
  // own (`hono/handlers/federated-registration.ts` — an earlier revision
  // DID revert its own cancel back to `ACTIVE` whenever it found the User
  // already active, which reopened AC-2: the just-"logged-out" token stayed
  // usable through that window). This function's own compensating check is
  // therefore the ONLY mechanism that keeps "logout lands before the
  // account is genuinely active" from producing a CANCELLED-journal/
  // ACTIVE-user split — every interleaving settles on either (ACTIVE
  // journal, ACTIVE user) or (CANCELLED journal, REGISTERED user); once
  // logout wins outright AFTER this point, (CANCELLED journal, ACTIVE user)
  // is the correct, intentionally accepted terminal pair (see
  // `logoutPendingRegistration`'s own comment).
  const postCommitRow = await PendingAuthRegistration.findById(row._id);
  if (postCommitRow?.state === 'CANCELLED') {
    if (userCas.modifiedCount === 1) {
      await User.updateOne({ _id: userId, status: User.STATUS_ACTIVE }, { $set: { status: User.STATUS_REGISTERED } });
    }
    return { kind: 'not_found' };
  }

  // AC-7 (single-winner), fast path: this call's own `finalized` write
  // above already succeeded WHILE it still held the lease — but nothing
  // between that write and this point has re-checked it yet. If this call
  // ran slow enough (past the 30s lease window — genuinely still in
  // progress, not crashed) for a NEW caller to legitimately reclaim the
  // SAME row's lease (`beginProvisioning`'s ACTIVE-resume branch) in the
  // meantime, bail out HERE, BEFORE ever touching `drainUserActivation`:
  // running (or even attempting) the activation side effect from an
  // already-fenced caller would durably mark it `done` and permanently
  // block a LATER, legitimate resume from ever reaching `active` itself in
  // turn (the marker-already-`done` guard above would reject it too — the
  // only remaining recovery would be a fresh IdP re-authentication, not a
  // plain resubmit). Do NOT revert the User CAS when fenced out — see the
  // matching, later re-check below for why. A second, final re-check right
  // before the `return` at the end of this function (after the drain)
  // closes the narrower remaining window where the reclaim lands strictly
  // DURING this very call's own (potentially slow) drain, past this point.
  if (postCommitRow?.provisioningLeaseToken !== leaseToken) {
    return { kind: 'not_found' };
  }

  const reloaded = (await User.findById(userId)) as UserDocument | null;

  if (!reloaded) {
    // The user vanished between the CAS and this read — nothing sane to
    // return; surface as a 500 (retryable) rather than fabricate a result.
    throw new Error(`provisionPendingRegistration: User ${String(userId)} not found immediately after its own ACTIVE CAS`);
  }

  if (reloaded.status === User.STATUS_ACTIVE) {
    const drainResult = await drainUserActivation(crowi, userId);
    if (drainResult !== 'done') {
      // AC-5/AC-6: the account is genuinely ACTIVE, but the durable
      // activation-time page side effect (`ensureUserPage`) could not be
      // confirmed complete — another caller currently holds the
      // `UserActivation` lease (a genuinely concurrent drain, OR a PRIOR
      // attempt that crashed mid-side-effect and whose lease has not yet
      // lapsed; this call cannot tell those apart). Handing out the
      // handoff here regardless would silently strand the marker: the
      // client would treat the response as a definitive success and never
      // retry, and nothing else in the system re-triggers
      // `drainUserActivation` until either a resubmit or a fresh IdP
      // re-authentication happens. Throwing (mapped by the HTTP handler to
      // its existing 500) is the spec's own contract for this shape
      // ("crash/temporary DB error は 500 とし grant を取消さず retry 可能
      // にする" — phase 2 spec's Error semantics section): nothing durable
      // is rolled back here (the journal and the User both stay ACTIVE),
      // and a client retry of the SAME grant resumes via
      // `beginProvisioning`'s own ACTIVE-row support.
      throw new Error(
        `provisionPendingRegistration: activation-time page side effect for User ${String(userId)} could not be confirmed complete (drain result: ${drainResult})`,
      );
    }
  }

  // AC-7 (single-winner), final re-check: the fast-path check above (right
  // before this function ever calls `drainUserActivation`) already rejects
  // the common case. It is not enough on its OWN, though — `drainUserActivation`
  // can itself take arbitrarily long (another page-creation DB round trip,
  // or just this process being slow/starved), so a reclaim can still land
  // strictly DURING that call, AFTER the fast-path check already passed.
  // Re-read the row ONE more time, freshly, right before deciding to report
  // `active` — deliberately NOT reusing `postCommitRow` (read BEFORE the
  // drain) — so a reclaim landing anywhere up to this exact point is still
  // caught: there is no `await` between this read and the `return` below,
  // so no FURTHER reclaim can land in between, making this the latest point
  // at which the check can run and still guard the outcome it gates. Unlike
  // the CANCELLED branch above, do NOT revert the User CAS when fenced out
  // here (or above): the reclaiming caller may already have completed its
  // OWN CAS/drain (or be about to), and an unconditional revert would
  // silently undo that caller's success out from under a response it may
  // already have sent. The account itself is never left in a bad state
  // either way — `userCas` is idempotent and the reclaiming caller's own
  // (still-fenced) writes are what genuinely finish the registration.
  //
  // Explicitly EXEMPT a `CANCELLED` row from this fencing check (unlike a
  // genuine reclaim, which never sets `state` back to `CANCELLED`): a
  // logout can legitimately land during this call's own (slow) drain too
  // (`hono/handlers/federated-registration.ts#logoutPendingRegistration`
  // clears `provisioningLeaseToken` unconditionally on every cancel, as its
  // own AC-2/AC-7 fencing invariant for an UNRELATED race — an in-flight
  // submit that has not yet reserved a `userId`). That is the SAME
  // "logout wins outright after the CANCELLED-revert check above" case
  // already documented as an intentionally accepted terminal pair
  // `(CANCELLED journal, ACTIVE user)` — this call's own ACTIVE CAS already
  // committed before the logout fired, so it still reports `active` to ITS
  // OWN caller (the only one who could ever complete this exact request);
  // the row staying `CANCELLED` is what correctly blocks every FUTURE
  // lookup/resume from here on.
  const finalRow = await PendingAuthRegistration.findById(row._id);
  if (finalRow?.state !== 'CANCELLED' && finalRow?.provisioningLeaseToken !== leaseToken) {
    return { kind: 'not_found' };
  }

  // AC-4/AC-8: never mint tokens here — the caller (`federated-registration.ts`)
  // issues a Phase 1 sender-constrained handoff code instead, redeemed via
  // the existing `POST /auth/handoff` (see that handler's comment for why).
  return { kind: 'active', user: reloaded, handoffJkt: row.handoffJkt, identity: { provider: row.provider, providerUserId: row.providerUserId } };
}

/** "24h from now" — the expiry every terminal state (ACTIVE / APPROVAL_PENDING / CANCELLED) is set to. Exported so `hono/handlers/federated-registration.ts`'s own CANCELLED write computes the same value rather than re-deriving it from `TERMINAL_TTL_MS`. */
export function terminalExpiry(): Date {
  return new Date(Date.now() + TERMINAL_TTL_MS);
}

async function createUserForRegistration(
  User: UserModel,
  userId: Types.ObjectId,
  row: PendingAuthRegistrationDocument,
  username: string,
): Promise<{ kind: 'ok' } | { kind: 'conflict'; field: 'username' | 'email' }> {
  const existingById = await User.findById(userId);
  if (existingById) {
    // Already created by a prior (crashed or concurrent) attempt against
    // this SAME reserved id — resuming, not conflicting.
    return { kind: 'ok' };
  }

  // Case-insensitive (`USER_UNIQUE_COLLATION`), matching the `User.email` /
  // `User.username` unique indexes' own collation (`models/user.ts`) — a
  // plain case-sensitive query here would miss a case-only-different
  // existing account, let `newUser.save()` below proceed, and hit the
  // index's own E11000 with no pre-check to have reported a clean
  // `conflict` outcome first. Passed as a query OPTION (3rd `findOne` arg,
  // same convention as the terminal's `existingByEmail` check above) so
  // this call stays compatible with the AC-7 regression test below that
  // stubs `User.findOne` as a plain async function (a chained `.collation()`
  // call on a non-`Query` return value would throw).
  const conflict = await User.findOne({ $or: [{ email: row.profile.email }, { username }] }, null, { collation: USER_UNIQUE_COLLATION });
  if (conflict) {
    if (String(conflict._id) === String(userId)) {
      // AC-7: a concurrent submit's own `newUser.save()` (against this SAME
      // reserved id) committed in the gap between our `existingById` check
      // above and this content-based one — this is OUR OWN reservation
      // resolving, not a genuine collision with someone else's account.
      // Without this check, a losing racer's content query finds the
      // winner's just-created user BY EMAIL/USERNAME (both calls submit the
      // identical grant + username) and misreports a spurious conflict
      // instead of converging.
      return { kind: 'ok' };
    }
    // Case-insensitive comparison (matches the collation the query above
    // already applied): a case-only email collision must report `'email'`,
    // never fall through to `'username'` just because the exact-case
    // strings differ.
    const field = conflict.email.toLowerCase() === row.profile.email.toLowerCase() ? 'email' : 'username';
    return { kind: 'conflict', field };
  }

  const newUser = new User();
  newUser._id = userId;
  newUser.name = row.profile.name || username;
  newUser.username = username;
  newUser.email = row.profile.email;
  newUser.lang = 'en';
  newUser.status = User.STATUS_REGISTERED;
  // The federated driver already required `email_verified: true` before
  // Phase 1 ever handed this profile to the terminal (umbrella spec) — no
  // confirmation email is sent (AC-4).
  newUser.emailConfirmedAt = new Date();

  try {
    await newUser.save();
  } catch (err) {
    if (isDuplicateKeyError(err)) {
      // Either a concurrent resume against the SAME reserved id already
      // won (idempotent — ok), or a genuine content conflict landed
      // between the pre-checks above and this save.
      const raced = await User.findById(userId);
      if (raced) return { kind: 'ok' };
      // The driver's own `keyPattern` (`mapDuplicateKeyError`) names the
      // colliding field directly — more robust than re-running a query,
      // and immune to the case-insensitivity gap a second plain query would
      // reopen (the underlying unique index's own collation is what raised
      // this E11000 in the first place, independent of any query collation).
      const code = mapDuplicateKeyError(err);
      return { kind: 'conflict', field: code === 'EMAIL_TAKEN' ? 'email' : 'username' };
    }
    throw err;
  }
  return { kind: 'ok' };
}

async function ensureIdentityLink(UserIdentity: UserIdentityModel, row: PendingAuthRegistrationDocument, userId: Types.ObjectId): Promise<'ok' | 'conflict'> {
  try {
    await UserIdentity.create({ userId, provider: row.provider, providerUserId: row.providerUserId });
    return 'ok';
  } catch (err) {
    if (!isDuplicateKeyError(err)) throw err;
    const existingIdentity = await UserIdentity.findOne({ provider: row.provider, providerUserId: row.providerUserId });
    if (existingIdentity && String(existingIdentity.userId) === String(userId)) return 'ok';
    return 'conflict';
  }
}
