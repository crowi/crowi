import crypto from 'node:crypto';

import { Document, Model, model, Schema, Types } from 'mongoose';

import Crowi from 'src/crowi';
import { isDuplicateKeyError } from 'src/util/map-duplicate-key-error';

/**
 * RFC-0014 phase 2 §"設計の主な判断" 1-2 — the federated JIT-registration
 * journal.
 *
 * Phase 1's callback, on a verified-but-unknown federated profile, upserts a
 * row here keyed by `{provider, providerUserId}` and hands the browser a
 * random one-time grant (this document stores only its SHA-256 hash — see
 * `hashGrant` below, which delegates to `models/oauth-device-code.ts#hashDeviceCode`,
 * the same primitive `OAuthDeviceCode` already uses for its own opaque
 * device-code secret).
 *
 * State machine (`state`):
 *   PENDING          — grant minted, `POST .../submit` not yet begun. TTL
 *                       15 minutes (`expiresAt`).
 *   PROVISIONING     — submit began (`beginProvisioning` CAS). `expiresAt`
 *                       is cleared (`null`) so the TTL monitor never sweeps
 *                       an in-flight/crashed provisioning — it is a durable
 *                       recovery record until it reaches a terminal state.
 *                       A fresh callback for the same provider identity
 *                       reissues a grant on this SAME row without touching
 *                       `state`/`userId`/the profile snapshot, so an
 *                       expired grant can always be replaced by
 *                       re-authenticating with the IdP.
 *   ACTIVE           — Open mode: the journal has finalized to this state,
 *                       which the User's own status CAS and its activation
 *                       page side effect follow (not necessarily
 *                       atomically — see `beginProvisioning`). TTL 24h,
 *                       but the SAME grant remains resumable
 *                       (`beginProvisioning`) until `UserActivation`'s
 *                       marker for this row's `userId` is `done`.
 *   APPROVAL_PENDING — Restricted mode: the User is REGISTERED, awaiting
 *                       admin approval. TTL 24h.
 *   CANCELLED        — the registration screen's logout link fired. TTL 24h.
 *
 * This is a single-document journal, not a distributed transaction —
 * `provisionPendingRegistration` (`services/auth-registration.ts`) resumes
 * from `userId` and each downstream document's own unique index, per the
 * umbrella spec's "マルチドキュメントトランザクションを使わない" constraint.
 */
const PENDING_TTL_MS = 15 * 60 * 1000;
/** TTL applied to every terminal state (ACTIVE / APPROVAL_PENDING / CANCELLED — see the state-machine doc comment above). Exported so callers outside this model (`services/auth-registration.ts`, `hono/handlers/federated-registration.ts`) compute the same "24h from now" rather than each re-deriving the literal. */
export const TERMINAL_TTL_MS = 24 * 60 * 60 * 1000;
/**
 * AC-7 — `beginProvisioning`'s lease window: two TRUE-concurrent submits for
 * the SAME grant must not both run `provisionPendingRegistration`'s body at
 * once (both would observe the row already `PROVISIONING`/`ACTIVE` and both
 * finalize/report success). A genuine SERIAL retry (a real crash, or a
 * network timeout with no concurrent second caller) must still resume once
 * the lease from the crashed attempt lapses — 30s is generous headroom over
 * this function's actual work (a handful of sequential document writes, no
 * external I/O) while staying well short of `UserActivation`'s own 60s
 * lease (a different, slower-to-legitimately-run operation).
 *
 * The lease alone (`provisioningLeaseExpiresAt`) is not enough: if the
 * ORIGINAL caller overruns the 30s window (still genuinely running, e.g. a
 * slow request) a SECOND caller can legitimately reclaim it, but the
 * ORIGINAL caller's own `finally` still releases what it thinks is "its"
 * lease — unconditionally clearing it would blow away the second caller's
 * still-live claim and let a THIRD caller in too. `provisioningLeaseToken`
 * is a fresh opaque value minted on every claim/reclaim; `releaseProvisioningLease`
 * only clears the lease when the caller's OWN token still matches the
 * document's current one, and the terminal finalize writes in
 * `services/auth-registration.ts` include the SAME token in their filter
 * ("fenced finalization") so a caller that has been silently fenced out
 * can never complete the state machine even if its own CAS conditions
 * would otherwise still match.
 */
const PROVISIONING_LEASE_MS = 30 * 1000;
const GRANT_RANDOM_BYTES = 32;
const LEASE_TOKEN_RANDOM_BYTES = 16;
/**
 * `issueRegistrationGrant`'s CAS-retry bound (mirrors `oauth-device-code.ts`'s
 * own `USER_CODE_MAX_ATTEMPTS` retry-loop convention). Each attempt is a
 * single atomic `findOneAndUpdate`/upsert — a loop iteration only fails to
 * make progress when the row's state changes again concurrently between two
 * atomic attempts, which does not compound across iterations.
 */
const ISSUE_GRANT_MAX_ATTEMPTS = 5;

export type PendingAuthRegistrationState = 'PENDING' | 'PROVISIONING' | 'ACTIVE' | 'APPROVAL_PENDING' | 'CANCELLED';

/** The federated profile fields JIT provisioning needs, snapshotted at callback time (never re-fetched from the IdP). */
export interface PendingAuthRegistrationProfileSnapshot {
  email: string;
  name?: string;
  imageUrl?: string;
}

export interface PendingAuthRegistrationDocument extends Document {
  _id: Types.ObjectId;
  provider: string;
  providerUserId: string;
  providerLabel: string;
  profile: PendingAuthRegistrationProfileSnapshot;
  grantHash: string;
  grantIssuedAt: Date;
  state: PendingAuthRegistrationState;
  userId: Types.ObjectId | null;
  /**
   * RFC 7638 JWK thumbprint of the sender key that PROVED it controlled the
   * ORIGINAL `/auth/providers/{name}/start` request (`FederatedAuthState.handoffJkt`
   * — `util/federated-auth-state.ts`), captured from the callback at grant
   * (re)issuance time (`issueRegistrationGrant`). The Open-mode submit
   * success handoff is bound to THIS value, never to a key the submit
   * request itself supplies — a holder of a merely-stolen registration URL
   * cannot rebind the eventual handoff to a key of their own choosing
   * (AC-8; same sender-constrained model Phase 1 uses for its own handoff).
   */
  handoffJkt: string;
  /**
   * AC-7 — single-flight lease over `provisionPendingRegistration`'s body,
   * held ONLY while a call is actively running (claimed by `beginProvisioning`,
   * released by `releaseProvisioningLease` in the caller's own `finally`).
   * `null` when no call currently holds it — see `PROVISIONING_LEASE_MS`.
   */
  provisioningLeaseExpiresAt: Date | null;
  /**
   * Fencing token for the CURRENT lease holder — a fresh opaque value set
   * every time `beginProvisioning` claims OR reclaims the lease. `null`
   * exactly when `provisioningLeaseExpiresAt` is `null`. See
   * `PROVISIONING_LEASE_MS`'s doc comment for why this exists.
   */
  provisioningLeaseToken: string | null;
  /** `null` while `PROVISIONING` (durable, not TTL-swept). Set for every other state. */
  expiresAt: Date | null;
  createdAt: Date;
}

export interface IssueRegistrationGrantInput {
  provider: string;
  providerUserId: string;
  providerLabel: string;
  profile: PendingAuthRegistrationProfileSnapshot;
  /** See `PendingAuthRegistrationDocument.handoffJkt`. */
  handoffJkt: string;
}

export interface PendingAuthRegistrationModel extends Model<PendingAuthRegistrationDocument> {
  /** SHA-256-hex of a plaintext registration grant — delegates to `OAuthDeviceCode.hashDeviceCode` (same primitive, different secret). */
  hashGrant(grant: string): string;
  /**
   * Upsert the journal row for `{provider, providerUserId}` and mint a
   * fresh one-time grant. Every branch below is a genuine atomic CAS (a
   * `state` — and, where relevant, `userId` — condition baked into the
   * `findOneAndUpdate`/upsert filter itself, never a value merely read
   * beforehand and trusted): a row concurrently advanced past what this
   * call observed (e.g. a submit's `beginProvisioning` reserving a
   * `userId`) simply fails to match, and the whole decision retries
   * (bounded — `ISSUE_GRANT_MAX_ATTEMPTS`) rather than blindly overwriting
   * whatever the row has become.
   *
   *  - No row yet, or an existing row that is `PENDING`, or `CANCELLED`
   *    with NO `userId` reserved (nothing created yet) — FRESH: resets
   *    `state`/`userId`/the profile snapshot and restarts the 15-minute
   *    TTL. ALSO clears `provisioningLeaseExpiresAt`/`provisioningLeaseToken`
   *    (AC-2/AC-8 fencing, same reasoning as the REVIVE branch below): a
   *    `PENDING`/`userId:null` row can still carry a STALE, still-live lease
   *    from a submit that called `beginProvisioning` (claiming the lease)
   *    but had not yet reached its own `userId` reservation CAS when a
   *    concurrent logout cancelled the row out from under it — leaving that
   *    lease token in place would let the OLD submit's later, fenced writes
   *    in `services/auth-registration.ts` (its own `userId` reservation is
   *    ALSO fenced on this same token — see that file) still match once
   *    this reset makes `userId: null` true again, letting it silently
   *    resurrect on a row a fresh re-authentication just reset for a NEW
   *    attempt.
   *  - `PROVISIONING` / `ACTIVE` / `APPROVAL_PENDING` (a `userId` — and,
   *    for the latter two, a real `User` + `UserIdentity` — already
   *    exists) — REISSUE (preserve): `state`/`userId`/the profile snapshot
   *    are untouched, only the grant/`handoffJkt` rotate (design decision
   *    2 — a durable row survives grant expiry). `APPROVAL_PENDING` also
   *    gets its 24h TTL refreshed so a user re-visiting their status page
   *    doesn't get swept mid-view.
   *  - `CANCELLED` WITH a `userId` already reserved (a logout — or a
   *    submit's own compensating revert — landed AFTER a real `User` was
   *    already created/linked for this row) — REISSUE (revive): reverts to
   *    `PROVISIONING` (the SAME crash-recovery path a mid-flight process
   *    crash uses — `beginProvisioning` already resumes it), preserving
   *    `userId` and the profile snapshot. Resetting `userId: null` here
   *    (the FRESH branch) would orphan the already-created account: the
   *    next submit would reserve a BRAND NEW `userId`, and
   *    `createUserForRegistration`'s own content-based pre-check would
   *    then find the ORIGINAL account by email and report a spurious,
   *    permanent conflict against the user's own prior account. ALSO clears
   *    `provisioningLeaseExpiresAt`/`provisioningLeaseToken` (AC-2/AC-8
   *    fencing): the cancel that produced this `CANCELLED` row may have
   *    landed while a PRIOR submit was still in-flight holding the lease —
   *    leaving its stale token in place would let that submit's later,
   *    fenced finalize write still match once `state !== 'CANCELLED'` holds
   *    again post-revival, completing the registration with a handoffJkt
   *    snapshot from before this revival rotated it.
   *
   * `handoffJkt` is ALWAYS refreshed to the input value regardless of
   * branch: reaching this function at all requires a genuine,
   * just-completed OAuth round trip for this exact
   * `{provider, providerUserId}` (verified by the caller before ever
   * invoking it), so rebinding the eventual handoff to whichever browser
   * most recently, successfully proved it controls that identity is always
   * correct — never a downgrade for a resumed/reissued row.
   */
  issueRegistrationGrant(input: IssueRegistrationGrantInput): Promise<string>;
  /**
   * Look up a row by plaintext grant. Returns `null` for an unknown grant,
   * a `CANCELLED` row, or one whose `expiresAt` has passed (checked
   * explicitly — the TTL monitor can lag by up to a minute, same convention
   * as `oauth-device-code.ts`).
   */
  findByRegistrationGrant(grant: string): Promise<PendingAuthRegistrationDocument | null>;
  /**
   * Atomically accept a submit against `grantHash` AND claim the AC-7
   * single-flight provisioning lease in the SAME write: the FIRST caller
   * CASes `PENDING` (unexpired) → `PROVISIONING` (`expiresAt: null`,
   * `provisioningLeaseExpiresAt` set 30s out). A caller that lands after
   * that CAS already happened (a resend, or a second concurrent request) is
   * accepted against the now-`PROVISIONING` OR `ACTIVE` row ONLY when no
   * OTHER caller currently holds a live lease on it — a TRUE-concurrent
   * second caller instead gets `null` (single-winner; the caller maps this
   * the same as an unknown grant). The caller MUST release the lease via
   * `releaseProvisioningLease` in a `finally` once done (success, business
   * rejection, or thrown error) so a legitimate serial retry is never stuck
   * waiting out the full 30s.
   *
   * Returns `null` for any other state (unknown/expired grant, a row that
   * reached a DIFFERENT terminal state — `APPROVAL_PENDING`/`CANCELLED` —
   * or a live lease held by a concurrent caller).
   *
   * `ACTIVE` is included deliberately (not just `PROVISIONING`): the
   * finalize write in `provisionPendingRegistration` sets the journal to
   * `ACTIVE` BEFORE it CASes the User itself, so a crash in that exact gap
   * — or between the User's CAS and the activation-time page side effect —
   * must remain resumable via the SAME grant (AC-3/AC-5/AC-6). The caller
   * (`provisionPendingRegistration`) is responsible for rejecting a
   * resubmit once the registration has genuinely, fully completed (its
   * `UserActivation` marker is `done`) so a leaked grant URL cannot replay
   * indefinitely for fresh token pairs after that point.
   *
   * An `ACTIVE` row's OWN 24h `expiresAt` is also honored here (a
   * `PROVISIONING` row's is always `null` — durable, TTL-exempt — so this
   * is a no-op for it): resuming an `ACTIVE` row PAST its expiry returns
   * `null` (mapped to `not_found`/404 by the caller) instead of silently
   * accepting it. Without this, a resume past that window would both slip
   * past the TTL sweep's own up-to-a-minute lag AND (via
   * `provisionPendingRegistration`'s own finalize write, which only resets
   * `expiresAt` on a FRESH — never a resumed — completion) have nothing to
   * stop it from being resubmitted indefinitely, turning a 24h-bounded
   * grant into an effectively unbounded bearer credential whenever the
   * activation marker never reaches `done`.
   *
   * The returned document's `provisioningLeaseToken` is this call's OWN
   * fencing token — the caller must thread it through to every subsequent
   * write it makes that depends on still being the exclusive holder
   * (`services/auth-registration.ts`'s finalize writes), and pass it back to
   * `releaseProvisioningLease` (never `null`, never a stale value from a
   * previous claim).
   */
  beginProvisioning(grantHash: string): Promise<PendingAuthRegistrationDocument | null>;
  /**
   * Release the AC-7 provisioning lease claimed by `beginProvisioning` —
   * idempotent, safe to call regardless of the row's current state. Only
   * clears the lease when `leaseToken` still matches the document's CURRENT
   * `provisioningLeaseToken` (fencing): a caller whose lease was reclaimed by
   * someone else while it kept running has a STALE token by the time it gets
   * here, and must not be able to clear the NEW holder's live lease.
   */
  releaseProvisioningLease(id: Types.ObjectId | string, leaseToken: string): Promise<void>;
}

export default (crowi: Crowi) => {
  const schema = new Schema<PendingAuthRegistrationDocument, PendingAuthRegistrationModel>({
    provider: { type: String, required: true },
    providerUserId: { type: String, required: true },
    providerLabel: { type: String, required: true },
    profile: {
      email: { type: String, required: true },
      name: { type: String, required: false },
      imageUrl: { type: String, required: false },
    },
    grantHash: { type: String, required: true, unique: true },
    grantIssuedAt: { type: Date, required: true },
    state: { type: String, enum: ['PENDING', 'PROVISIONING', 'ACTIVE', 'APPROVAL_PENDING', 'CANCELLED'], required: true, default: 'PENDING' },
    userId: { type: Schema.Types.ObjectId, ref: 'User', default: null },
    handoffJkt: { type: String, required: true },
    provisioningLeaseExpiresAt: { type: Date, default: null },
    provisioningLeaseToken: { type: String, default: null },
    expiresAt: { type: Date, default: null },
    createdAt: { type: Date, default: Date.now },
  });

  schema.index({ provider: 1, providerUserId: 1 }, { unique: true, name: 'pendingAuthRegistration_provider_providerUserId_unique' });
  // TTL — skipped by mongod for documents where the field is absent/`null`
  // (the `PROVISIONING` state), so a durable in-flight row is never swept.
  schema.index({ expiresAt: 1 }, { expireAfterSeconds: 0, name: 'pendingAuthRegistration_ttl' });

  schema.statics.hashGrant = function (grant: string): string {
    return crowi.model('OAuthDeviceCode').hashDeviceCode(grant);
  };

  schema.statics.issueRegistrationGrant = async function (input: IssueRegistrationGrantInput): Promise<string> {
    const grant = crypto.randomBytes(GRANT_RANDOM_BYTES).toString('base64url');
    const grantHash = PendingAuthRegistration.hashGrant(grant);
    const now = new Date();

    for (let attempt = 0; attempt < ISSUE_GRANT_MAX_ATTEMPTS; attempt += 1) {
      // FRESH: no row yet, or a row that never got past `PENDING`, or was
      // `CANCELLED` before ever reserving a `userId` — reset everything.
      // The `upsert` filter's `state`/`userId` conditions (not a value read
      // beforehand) make this a genuine CAS: a row concurrently advanced
      // past this point simply doesn't match, and the upsert's own insert
      // attempt then collides with the unique `{provider, providerUserId}`
      // index instead of silently creating a duplicate.
      try {
        const fresh = await PendingAuthRegistration.findOneAndUpdate(
          {
            provider: input.provider,
            providerUserId: input.providerUserId,
            $or: [{ state: 'PENDING' }, { state: 'CANCELLED', userId: null }],
          },
          {
            $set: {
              providerLabel: input.providerLabel,
              profile: input.profile,
              grantHash,
              grantIssuedAt: now,
              state: 'PENDING',
              userId: null,
              handoffJkt: input.handoffJkt,
              expiresAt: new Date(now.getTime() + PENDING_TTL_MS),
              // See the FRESH-branch JSDoc above (AC-2/AC-8 fencing).
              provisioningLeaseExpiresAt: null,
              provisioningLeaseToken: null,
            },
            $setOnInsert: { provider: input.provider, providerUserId: input.providerUserId, createdAt: now },
          },
          { upsert: true, returnDocument: 'after' },
        );
        if (fresh) return grant;
      } catch (err) {
        // A row already exists but didn't match the filter above (it has a
        // `userId` reserved, or is `PROVISIONING`/`ACTIVE`/`APPROVAL_PENDING`)
        // — the upsert's own insert attempt collided with the unique index
        // instead. Fall through to the reissue branches below rather than
        // treat this as fatal.
        if (!isDuplicateKeyError(err)) throw err;
      }

      // REISSUE (preserve): PROVISIONING / ACTIVE / APPROVAL_PENDING —
      // already reserved a `userId` (and, for the latter two, created a
      // real `User` + `UserIdentity`) — never reset it, only rebind the
      // grant/`handoffJkt` to this fresh proof.
      const reissued = await PendingAuthRegistration.findOneAndUpdate(
        { provider: input.provider, providerUserId: input.providerUserId, state: { $in: ['PROVISIONING', 'ACTIVE', 'APPROVAL_PENDING'] } },
        { $set: { grantHash, grantIssuedAt: now, handoffJkt: input.handoffJkt } },
        { returnDocument: 'after' },
      );
      if (reissued) {
        if (reissued.state === 'APPROVAL_PENDING') {
          // Best-effort TTL refresh (a user re-visiting their status page
          // shouldn't get swept mid-view) — guarded on the state just
          // observed, so a further concurrent transition can't have its
          // `expiresAt` clobbered by this unrelated write.
          await PendingAuthRegistration.updateOne(
            { _id: reissued._id, state: 'APPROVAL_PENDING' },
            { $set: { expiresAt: new Date(now.getTime() + TERMINAL_TTL_MS) } },
          );
        }
        return grant;
      }

      // REISSUE (revive): the row WAS cancelled (a logout, or a submit's
      // own AC-2 compensating revert) AFTER it already reserved a `userId`
      // — a real `User` (and, once `ensureIdentityLink` ran, a
      // `UserIdentity`) exists for it. Revive the SAME row as a fresh
      // `PROVISIONING` recovery record (the SAME crash-recovery path a
      // mid-flight process crash uses — see the interface JSDoc above for
      // why this must not fall through to the FRESH branch instead).
      const revived = await PendingAuthRegistration.findOneAndUpdate(
        { provider: input.provider, providerUserId: input.providerUserId, state: 'CANCELLED', userId: { $ne: null } },
        {
          $set: {
            state: 'PROVISIONING',
            expiresAt: null,
            grantHash,
            grantIssuedAt: now,
            handoffJkt: input.handoffJkt,
            // AC-2/AC-8 fencing (reviewer 2026-08-06T13:15:00Z): the row
            // being revived was `CANCELLED` while a PRIOR submit may still
            // be in-flight and holding `provisioningLeaseToken` from BEFORE
            // the cancel (its own `finally`/`releaseProvisioningLease` call
            // has not run yet). Left untouched, that stale token would still
            // match `provisionClaimedRow`'s fenced finalize filter
            // (`state !== 'CANCELLED'` now holds again post-revival,
            // `provisioningLeaseToken: <stale>` still equals the document's
            // current value) — letting a submit from BEFORE the logout
            // complete the registration anyway, using the handoffJkt
            // snapshot it captured before this revival rotated it. Clearing
            // both lease fields here means that stale token can never match
            // again: the old caller's finalize write becomes a genuine
            // no-op (`not_found`), and the newly-revived row starts with no
            // lease held, so the NEXT (fresh) submit can claim it normally.
            provisioningLeaseExpiresAt: null,
            provisioningLeaseToken: null,
          },
        },
        { returnDocument: 'after' },
      );
      if (revived) return grant;

      // None of the three CASes matched: the row's state moved again
      // between these attempts (e.g. PROVISIONING -> CANCELLED via a
      // concurrent logout, or a fresh PENDING reappeared after our own
      // upsert lost the dup-key race). Retry the whole decision.
    }

    throw new Error(`issueRegistrationGrant: exhausted retries reconciling state for {provider: ${input.provider}, providerUserId: ${input.providerUserId}}`);
  };

  schema.statics.findByRegistrationGrant = async function (grant: string): Promise<PendingAuthRegistrationDocument | null> {
    const grantHash = PendingAuthRegistration.hashGrant(grant);
    const row = await PendingAuthRegistration.findOne({ grantHash, state: { $ne: 'CANCELLED' } });
    if (!row) return null;
    if (row.expiresAt !== null && row.expiresAt.getTime() < Date.now()) return null;
    return row;
  };

  schema.statics.beginProvisioning = async function (grantHash: string): Promise<PendingAuthRegistrationDocument | null> {
    const now = new Date();
    const lease = new Date(now.getTime() + PROVISIONING_LEASE_MS);
    // A fresh token on EVERY claim/reclaim (never reused) — the fencing
    // value `releaseProvisioningLease` and the finalize writes in
    // `services/auth-registration.ts` compare against.
    const leaseToken = crypto.randomBytes(LEASE_TOKEN_RANDOM_BYTES).toString('hex');

    const flipped = await PendingAuthRegistration.findOneAndUpdate(
      { grantHash, state: 'PENDING', expiresAt: { $gt: now } },
      { $set: { state: 'PROVISIONING', expiresAt: null, provisioningLeaseExpiresAt: lease, provisioningLeaseToken: leaseToken } },
      { returnDocument: 'after' },
    );
    if (flipped) return flipped;
    // PROVISIONING/ACTIVE resumption (see the JSDoc above), single-flight
    // (AC-7): only claimable when no OTHER caller currently holds a live
    // lease — a TRUE-concurrent second caller's query matches nothing here
    // (the first caller's lease, just set above, is still in the future)
    // and this returns `null`, mapped by the caller to `not_found`. A
    // RECLAIM (the original caller overran its lease) mints a NEW token —
    // the original caller's own `releaseProvisioningLease` call, once it
    // eventually runs with its now-stale token, will no longer match and
    // therefore cannot clear THIS claim (fencing).
    return PendingAuthRegistration.findOneAndUpdate(
      {
        grantHash,
        state: { $in: ['PROVISIONING', 'ACTIVE'] },
        $and: [
          { $or: [{ provisioningLeaseExpiresAt: null }, { provisioningLeaseExpiresAt: { $lt: now } }] },
          // `PROVISIONING` rows are always `expiresAt: null` (durable,
          // TTL-exempt — see the state-machine doc comment above), so this
          // is a no-op for them; an `ACTIVE` row genuinely carries a 24h
          // `expiresAt` and MUST still honor it here (see the interface
          // JSDoc above).
          { $or: [{ expiresAt: null }, { expiresAt: { $gt: now } }] },
        ],
      },
      { $set: { provisioningLeaseExpiresAt: lease, provisioningLeaseToken: leaseToken } },
      { returnDocument: 'after' },
    );
  };

  schema.statics.releaseProvisioningLease = async function (id: Types.ObjectId | string, leaseToken: string): Promise<void> {
    // Fenced: only the CURRENT holder's own token can clear the lease — a
    // caller that ran past the 30s window and got silently reclaimed by
    // someone else must not blow away that new holder's live lease.
    await PendingAuthRegistration.updateOne(
      { _id: id, provisioningLeaseToken: leaseToken },
      { $set: { provisioningLeaseExpiresAt: null, provisioningLeaseToken: null } },
    );
  };

  const PendingAuthRegistration = model<PendingAuthRegistrationDocument, PendingAuthRegistrationModel>(
    'PendingAuthRegistration',
    schema,
    'pending_auth_registrations',
  );

  return PendingAuthRegistration;
};
