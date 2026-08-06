# RFC-0019: TOTP two-factor authentication

- **Status**: Draft
- **Author**: @sotarok
- **Created**: 2026-07-27
- **Depends on**:
  - RFC-0006 (Hono Integration) — this RFC changes the Hono authentication
    boundary and the web JWT middleware introduced there.
  - RFC-0008 (Migration Framework) — existing User documents require additive
    authentication-generation fields before version-bearing tokens become
    mandatory.
  - RFC-0010 (OAuth 2.0 Foundation & Scoped API Access) — PATs, OAuth access
    tokens, authorization codes, device codes, and refresh tokens remain
    independent credentials with the revocation rules defined here.
- **Related**:
  - RFC-0011 (Crowi MCP Server) — MCP accepts PAT or OAuth Bearer
    authentication and has no interactive password-login state.
  - RFC-0012 (Crowi CLI) — the CLI authenticates through browser
    authorization-code + PKCE, device authorization, or a pre-issued PAT.
  - RFC-0014 (Auth Provider Plugins) — inbound federated authentication is a
    separate authority from local-password authentication.

## §0 Summary

Crowi will support opt-in TOTP two-factor authentication for local-password
sign-in, ten single-use backup codes, administrator recovery, and a global
policy that requires two-factor enrollment for local-password authentication.

The authentication boundary is a short-lived, single-use, MongoDB-backed
opaque pre-authentication challenge. A correct password or another accepted
first factor is not sufficient to issue an access or refresh JWT when TOTP or
forced enrollment is required. The API instead returns an opaque challenge
token of at least 256 bits, of which only the SHA-256 hash is stored, and
pairs it with an `HttpOnly` per-browser binding cookie. The token is not a
JWT, is held in client memory rather than any persistent store, and is
accepted only by dedicated two-factor endpoints.

Pending challenges live in a bounded array embedded on the User. Embedding is
required rather than stylistic: the attempt budget and the single-use
consumption must be fenced by one atomic operation, and Crowi's default
MongoDB is standalone, so multi-document transactions are unavailable.
Verification spends the account attempt budget and consumes the challenge in
two conditional updates against that one document. The array is bounded by
`$slice`, which needs no admission check — issuing a challenge already
requires a correct first factor, so the bound protects document size, not
security.

Three separate fences replace what one version would otherwise have to do at
once: `mfaFenceVersion` invalidates in-flight challenges when the account's
security state moves, `authVersion` invalidates issued JWTs, and a monotonic
`lastUsedTotpStep` prevents replay. A successful login advances only the last
of these, so completing one challenge never invalidates a sibling — which is
what allows a login in one tab and the editor's inline reauthentication to
proceed independently.

Splitting the transport is what makes those siblings representable. A cookie
is keyed by name, so a second challenge would replace the first; putting the
identity in the response body gives each client its own token while the
per-browser binding stays where script cannot read it. No separate CSRF nonce
is needed, because the body token already is a value a cross-site page cannot
obtain. This RFC supports only the same-origin
topology in which Next proxies `/api/*` (`packages/web/next.config.ts`).
Split web/API origins are unsupported until a separately reviewed transport
change makes the shared client and direct refresh request credentialed and
proves Set-Cookie plus cookie-backed verification in a real browser. CORS
server support alone does not opt a browser into credentials.

This RFC does **not** claim that the wiki origin protects enrollment secrets
or localStorage-held JWTs from same-origin script, and it does not make MFA
conditional on fixing that. Script on the origin can already read the final
tokens, so no pre-authentication transport can be stronger than the session it
leads to; withholding MFA does not improve the origin, and shipping MFA does
not degrade it. Origin containment is tracked as its own concern in §12.2.

Final web access and refresh JWTs carry `authVersion`, the global MFA policy
epoch, and authentication methods. Every protected web request and every
refresh compares those claims against state the middleware already loads.
Enabling or disabling TOTP, regenerating backup codes, resetting or changing a
password, and administrator recovery invalidate old web access and refresh
JWTs immediately. Global policy enablement is enforced by the epoch claim
instead, so it takes effect on every existing session at once rather than
waiting for a per-user rewrite to reach that user.

Ordinary self-service TOTP changes revoke web JWTs only. They preserve PAT and
OAuth credentials so MCP, CLI, and automation do not stop unexpectedly. An
administrator or operator reset is a compromise-recovery operation and
increments a separate `apiCredentialVersion`, immediately rejecting PAT and
OAuth credentials as well.

Delivery is split into three reviewable phases:

1. a secure opt-in vertical slice, including backup codes, password-reset and
   activation hardening, inline editor reauthentication, Mongo-backed abuse
   controls, web-session invalidation, and operator break-glass;
2. administrator reset, durable security events, and recovery UX; and
3. global enforcement for local-password users, with forced setup and
   administrator-lockout guards.

No phase may ship a QR-only enrollment flow without its challenge, replay,
recovery, rate-limit, secret-storage, and revocation controls.

## §1 Background and motivation

### §1.1 Current web-session boundary

Password login currently loads an active User, verifies the password, and
immediately calls `generateTokens()`
(`packages/api/src/hono/handlers/token-auth.ts:84-126`). There is no state
between “password accepted” and “fully authenticated session.”

The current web JWT contains only `userId`, `email`, and `type`; access tokens
live for one hour and refresh tokens for thirty days
(`packages/api/src/util/jwt.ts:15-28,41-70`). The refresh route verifies a
refresh JWT, loads an active User, and issues a new pair without a
session-generation check
(`packages/api/src/hono/handlers/token-auth.ts:223-242`).

`createJwtAuth` is the protected-route boundary. It accepts:

- a web access JWT from a Bearer header or the `crowi.accessToken` cookie;
- an OAuth access JWT from a Bearer header; or
- a `crowi_pat_...` opaque PAT from a Bearer header.

The union is explicit in
`packages/api/src/hono/middleware/auth.ts:61-141`. A pending-authentication
cookie MUST remain outside it.

The web client stores final access and refresh JWTs in localStorage and mirrors
the access JWT into a host cookie
(`packages/web/src/lib/auth-token.ts:28-40`). API calls then read the access
JWT from localStorage, and refresh reads the stored refresh JWT
(`packages/web/src/lib/api-client.ts:67-94,127-156`). A separate
authentication origin could not complete this host-local storage handoff
without adding a new cross-origin credential protocol. All login,
verification, enrollment, and recovery UI therefore remains on the existing
Crowi web origin.

### §1.2 Every web-token issuer is in scope

The password handler is not the only place that issues a web session:

| Path | Current issuance point | Required TOTP behavior |
|---|---|---|
| Password login | `packages/api/src/hono/handlers/token-auth.ts:125` | Challenge an enrolled user before tokens. |
| Refresh | `packages/api/src/hono/handlers/token-auth.ts:223-242` | Do not prompt again; require matching `authVersion`. |
| Activation | `packages/api/src/hono/handlers/activation.ts:58-77` | Reject an already-completed activation and use forced setup when policy requires it. |
| Password reset | `packages/api/src/hono/handlers/password-reset.ts:73-103` | Change the password and invalidate sessions, but challenge an enrolled user before tokens. |
| Invitation acceptance | `packages/api/src/hono/handlers/invite-accept.ts:78-86` | Use forced setup when policy requires it. |

Password reset is the clearest bypass risk: it currently changes the password
and signs the user in during the same request. Activation is also a first
factor: its JWT is valid for 24 hours
(`packages/api/src/util/mail-token.ts:23-33`), and the current handler accepts
an already active User and issues a fresh session
(`packages/api/src/hono/handlers/activation.ts:53-77`).

Every interactive issuer MUST call one completion service. Handlers MUST NOT
decide independently that a password, reset link, activation link, or
invitation is sufficient.

### §1.3 Editor reauthentication is a first-class login surface

The collaborative editor deliberately reauthenticates without navigation.
When refresh fails, `SessionReauthProvider` suppresses the authenticated-layout
redirect so the mounted Y.Doc and CodeMirror buffer survive
(`packages/web/src/lib/session-reauth-context.tsx:83-106,210-218`). Its modal
calls the same `loginWithPassword` helper as the public login form and closes
only after fresh tokens have been stored
(`packages/web/src/components/editor/session-reauth-modal.tsx:17-34,60-74`).

TOTP MUST preserve that behavior. The modal must accept the password, then
TOTP or a backup code, receive final JWTs, and call `resolveReauth()` without
changing route or unmounting the editor. Redirecting to `/login` is an
explicit destructive escape hatch because it loses the unsaved buffer
(`session-reauth-modal.tsx:77-83`); it is not the normal second-factor path.

### §1.4 Why this is an RFC

Two-factor authentication changes:

- the boundary between a first factor and a fully authenticated principal;
- access and refresh JWT validity;
- storage of a per-user decryptable authentication secret;
- password reset, activation, invitation, and refresh semantics;
- PAT, OAuth, CLI, MCP, and future federated-login assurance;
- administrator recovery and sole-administrator lockout behavior; and
- organization-wide authentication policy.

Those decisions establish precedent for WebAuthn, passkeys, and future
step-up authentication. They belong in a repository-level architecture record
rather than a screen-specific implementation specification.

## §2 Goals and non-goals

### §2.1 Goals

- Let a local-password user enroll an authenticator application by scanning a
  QR code or entering a Base32 secret manually.
- Require TOTP or a backup code before issuing a full web session to an
  enrolled local-password user.
- Keep pending authentication out of JavaScript-readable storage by using a
  short-lived HttpOnly cookie.
- Complete both public login and editor inline reauthentication through the
  same discriminated login helper without navigation.
- Protect password reset, activation, invitation, and every other interactive
  web-token issuance path.
- Store TOTP secrets as authenticated ciphertext and refuse enrollment when
  encryption is unavailable.
- Issue ten high-entropy, hash-only, single-use backup codes; expose their
  remaining count and support complete regeneration.
- Make attempts, challenge supersession, TOTP replay prevention, backup-code
  consumption, and challenge consumption correct in one User document with or
  without Redis.
- Revoke both access and refresh web JWTs immediately after security-state
  changes.
- Preserve PAT and OAuth credentials during ordinary self-service TOTP
  changes, while revoking every credential during administrator recovery.
- Bind activation and password-reset credentials to User state and a
  generation so an old link cannot mint a session.
- Provide administrator recovery, an operator break-glass command, and a
  global local-password policy without requiring Redis.
- Define explicit behavior for PAT, MCP, `@crowi/cli`, outbound OAuth, and
  future inbound federated providers.

### §2.2 Non-goals

- SMS or email one-time passwords.
- WebAuthn, passkeys, or hardware security keys.
- “Remember this device” bypass cookies.
- Risk-based or adaptive authentication.
- Requiring a TOTP on every PAT, OAuth, MCP, or CLI API request.
- Implementing the RFC-0014 inbound auth-provider runtime.
- Per-role enforcement, grace-period scheduling, or per-group policy.
- A generic factor-plugin abstraction before Crowi has a second factor.
- A KMS-backed envelope-encryption implementation or key-rotation protocol.
- Preserving old JWTs, a legacy TOTP wire format, or plaintext TOTP secrets.
  Crowi 2.0 is pre-production alpha; the feature begins with one secure format.

## §3 Existing authentication paths and normative policy

Inbound authentication and outbound OAuth are different axes. RFC-0014 covers
the former; RFC-0010 through RFC-0012 cover the latter.

### §3.1 Authentication-path matrix

| Path | Current code-backed behavior | Normative policy |
|---|---|---|
| Local-password web login | Password success immediately issues web JWTs (`token-auth.ts:120-126`). | If enrolled, MUST return a TOTP/backup challenge. If global policy applies and enrollment is absent, MUST return a forced-setup challenge. |
| Editor inline reauthentication | The mounted editor calls `loginWithPassword` in a non-dismissible modal (`session-reauth-modal.tsx:17-34,60-74`). | MUST complete password and TOTP/backup steps inside that modal. It MUST NOT navigate or unmount the Y.Doc. |
| Password reset | A valid mail token changes the password and issues web JWTs (`password-reset.ts:73-103`). | MUST atomically consume a current generation, increment `authVersion`, and challenge enrolled users before tokens. |
| Administrator password or email change | Admin routes can reset a password or update an email (`admin/users.ts:241-287`). | MUST increment `passwordResetGeneration`, invalidate pending authentication, and increment `authVersion`; old reset links become unusable. |
| Activation | The current handler treats repeat activation as idempotent sign-in (`activation.ts:58-77`). | MUST be bound to pending activation state and `activationGeneration`; already completed or stale activation MUST be rejected. |
| Invitation acceptance | Status already provides a single-use boundary (`invite-accept.ts:43-69`). | MUST use central completion and forced setup when policy applies. |
| Web refresh | Refresh loads the User and issues a pair (`token-auth.ts:223-242`). | MUST NOT prompt for TOTP. It MUST require matching `authVersion` and preserve `amr` and `authTime`. |
| PAT request authentication | `createJwtAuth` loads a PAT by hash (`auth.ts:87-118`). | MUST NOT request live TOTP per API request. |
| PAT management | `/me/access-tokens` is web-session-only and returns plaintext once. | MUST require a final web session. Phase 2 adds recent-authentication assurance for issuance. |
| MCP | `/api/mcp` accepts PAT/OAuth Bearer authentication and has no independent login (`packages/api/src/mcp/attach.ts:1-20,55-69`). | MUST NOT prompt for TOTP. |
| CLI authorization-code + PKCE | The CLI opens a browser and exchanges a code (`packages/cli/src/lib/oauth.ts:217-287`). | The browser completes local TOTP first. Code exchange MUST NOT prompt again. |
| CLI device flow | The CLI opens a verification URL and polls (`packages/cli/src/lib/oauth.ts:317-345`). | Browser approval completes local TOTP first. Poll and exchange MUST NOT prompt again. |
| OAuth refresh | OAuth refresh is a non-interactive credential lifecycle defined by RFC-0010. | MUST NOT prompt for TOTP; it follows `apiCredentialVersion`. |
| Future inbound federated login | RFC-0014 delegates authentication to a provider. | MUST NOT receive an additional Crowi TOTP challenge. Provider `amr`/`acr` may inform later step-up policy. |

The global policy is evaluated by authentication source. If an account can
sign in with both a local password and a future federated provider, only the
local-password path is subject to Crowi TOTP.

### §3.2 Token-issuance matrix

| Completed event | Final web tokens? | Required result |
|---|---|---|
| Correct password; TOTP neither enrolled nor required | Yes | `amr: ['pwd']`. |
| Correct password; TOTP enrolled | No | Set pending cookie and return `two_factor_required`. |
| Correct password; policy requires setup | No | Set pending cookie and return `two_factor_setup_required`. |
| Correct password + valid TOTP | Yes | `amr: ['pwd', 'otp']`. |
| Correct password + valid backup code | Yes | `amr: ['pwd', 'recovery']`. |
| Password-reset link; TOTP enrolled | No | Change password, revoke old web sessions, then issue a `password_reset` challenge. |
| Password-reset link + valid TOTP | Yes | `amr: ['recovery', 'otp']`. |
| Password-reset link + valid backup code | Yes | `amr: ['recovery']`. |
| Activation/invitation under required policy | No | Forced-setup challenge. |
| Forced setup + first valid TOTP | Yes | Enable TOTP, return backup codes once, and issue a fresh version-matching pair. |
| Matching final refresh JWT | Yes | Preserve `amr` and original `authTime`; require matching `authVersion`. |
| Pending cookie presented to a normal protected route | Never | `401 AUTHENTICATION_REQUIRED`. |

## §4 Candidate approaches and decision

### §4.1 Bounded challenge array embedded on the User — selected

After a first factor succeeds, the completion service either issues final
tokens or appends a challenge to `user.mfaChallenges`:

1. generate at least 32 random bytes for the challenge token;
2. store only its hash, alongside purpose, the `mfaFenceVersion` snapshot,
   expiry, first-factor methods, and the browser-binding hash;
3. append it with a single bounded operation,
   `$push: { mfaChallenges: { $each: [c], $slice: -5 } }`;
4. return the opaque token in the response body for the initiating client to
   hold in memory, and set the browser-binding secret in a short-lived
   HttpOnly cookie (§7.1); and
5. verify with one conditional update that spends the attempt budget, then a
   second that atomically consumes the challenge (§5.2, §5.3).

The decisive constraint is that **the attempt budget and the single-use
consumption must be fenced by the same atomic operation**, and Crowi's default
MongoDB is standalone (`docker-compose.yml`'s `mongodb: image: mongo:8`, with
no replica-set initialisation), so multi-document transactions are
unavailable. Embedding puts both on one document and makes each step a single
`findOneAndUpdate`.

The array is bounded at five elements by `$slice`, which is atomic and needs no
count-then-insert. **The bound is not a security control.** Creating a
challenge already requires a correct password, so an actor who can create
challenges without limit has already defeated the first factor. The bound
exists solely to keep the User document small, which is why it needs no
stronger enforcement than `$slice` provides.

Several challenges may be live at once because a login in one tab must not
destroy the pending challenge of the editor's in-place reauthentication, which
holds an unsaved Y.Doc mounted (`packages/web/src/lib/session-reauth-context.tsx:83-90`).
Each challenge is addressed by its own token, so the parallelism is inherent to
the transport rather than a special case.

The trade-off is a User write for challenged login and for failed
verification. That cost is acceptable at an authentication boundary and buys
restart tolerance, multi-replica correctness, atomic factor consumption, and
simple crash behaviour.

### §4.2 Short-lived pre-authentication JWT — rejected

A separate JWT issuer and strict accepted-type allowlist could isolate a
pre-authentication JWT safely. Crowi's current verifier already requires an
explicit accepted type (`packages/api/src/util/jwt.ts:105-125`), and WebSocket
tokens demonstrate a distinct short-lived issuer
(`packages/api/src/util/ws-token.ts:5-20,59-70`).

The JWT nevertheless does not remove state. Failed-attempt counting,
single-use consumption, supersession, backup-code consumption, and TOTP replay
prevention all still require the User document. A signed pending token would
therefore add issuer, claim, clock, and revocation semantics without removing
a Mongo read or write. The opaque cookie is simpler.

### §4.3 Separate challenge collection — rejected

A standalone `TwoFactorChallenge` collection, hash-addressed and consumed with
`findOneAndUpdate`, mirrors the OAuth authorization-code model
(`packages/api/src/models/oauth-authorization-code.ts:128-133`). That precedent
does not carry, because it atomically consumes **one** document and nothing
else. Here the attempt budget belongs on the User — it is the account, not the
individual challenge, that must be rate-limited, or an attacker refreshes the
budget simply by starting a new challenge.

Splitting the budget and the consumption across two documents therefore
requires either a transaction, which standalone MongoDB does not offer, or a
reservation protocol with its own crash recovery. The reservation is where the
design fails in practice: a reservation taken before the factor is checked has
no release path on a wrong code, so one mistyped digit can strand the account
until the reservation expires.

Embedding removes the problem rather than managing it. A single embedded slot
would indeed let a new first factor supersede an in-progress login, but that is
an argument for a bounded array (§4.1), not for a second collection.

### §4.3.1 Why the array is not a single slot

A single slot makes the second tab silently destroy the first tab's challenge.
When the first tab is the editor's inline reauthentication, that is exactly the
unsaved-buffer loss §1.3 exists to prevent. Five slots make the collision
require five concurrent challenges for one account, which no legitimate flow
produces and which a password-holder gains nothing by forcing.

### §4.4 Redis-backed pending authentication — rejected

Redis provides convenient expiry and counters, but `REDIS_URL` is optional.
Collaboration and notifications explicitly run in a degraded single-instance
mode without Redis (`packages/api/src/collab/attach.ts:239-253`;
`packages/api/src/notifications/attach.ts:87-92`). A process-local fallback
would lose challenges on restart and be incorrect across replicas.

Redis remains defense in depth. It is not a source of authentication truth.

### §4.5 Cookie-only challenge identity — rejected

Putting the challenge identity itself in the cookie, so that the browser
presents everything ambiently, is the conventional shape and is what §7.1
deliberately does not do.

It cannot represent parallel challenges. A cookie is keyed by name, path and
domain, so issuing a second challenge either replaces the first cookie or
requires per-challenge cookie names — and the first option silently destroys
an in-flight login while the second leaks challenge count into a namespace the
server must then garbage-collect. Because the editor's inline reauthentication
is precisely the login most likely to be destroyed, and it is holding an
unsaved buffer (§1.3), that failure mode is disqualifying.

The objection to a body-borne token is that script on the wiki origin can read
it. That is true and is answered honestly in §7.1 and §12.2: the same script
can already read the final access and refresh tokens from `localStorage`, so
the ambient cookie protects the *challenge* better than the *session* it leads
to — a gain with no security value. What the cookie genuinely contributes is
browser binding, which is why §7.1 keeps a cookie for exactly that and nothing
else.

The reverse case — a native client performing password login directly, for
which a body token would be the only workable transport — does not exist
today: the CLI uses browser authorization-code or device flows
(`packages/cli/src/lib/oauth.ts:217-287,317-345`) and MCP accepts PAT or OAuth
Bearer credentials (`packages/api/src/mcp/attach.ts:1-20,55-69`). The chosen
transport happens to extend to such a client if one appears, but that is a
convenience rather than the reason for it.

### §4.6 Dedicated authentication origin — considered and not adopted

Final JWTs belong to the Crowi web origin's localStorage and host cookie
(`packages/web/src/lib/auth-token.ts:28-40`). No code transfers those
credentials from a separate origin to the wiki origin. Production CORS admits
only `CLIENT_URL` and the Crowi base URL
(`packages/api/src/hono/middleware/cors.ts:42-71`), and the Next configuration
contains neither host routing nor an authentication-specific CSP/header layer
(`packages/web/next.config.ts:57-173`).

Adding an authentication origin would require a new credential handoff, host
routing, deployment, and recovery design — and it would break the editor's
in-place reauthentication outright, because reaching another origin means
navigating away from the mounted Y.Doc that §1.3 exists to preserve.

It is therefore **not adopted, and not treated as a prerequisite**. The
honest position, stated in full in §12.2, is that origin-level active-content
containment is an orthogonal concern: script running on the wiki origin can
already read the final JWT out of localStorage, so no pre-authentication
transport can be made stronger than the credential it guards. MFA is not
what makes that origin need containment, and withholding MFA does not make
the origin safer.

## §5 Data model

Field names are prescriptive at the conceptual boundary. An implementation
spec may choose equivalent Mongoose nesting only if the same atomic predicates
remain visible.

### §5.1 User authentication state

```ts
type MfaChallenge = {
  tokenHash: string;                // sha256 of the opaque token held in client memory
  bindingHash: string;              // sha256 of the per-browser binding-cookie secret
  purpose:
    | 'login'
    | 'password_reset'
    | 'policy_setup'
    | 'step_up';
  firstFactorAmr: ('pwd' | 'recovery')[];
  fenceVersion: number;             // snapshot of User.mfaFenceVersion at issue
  stagedPasswordHash: string | null; // password_reset only — committed on success
  expiresAt: Date;
  createdAt: Date;
};

type PendingTwoFactorEnrollment = {
  secretEncrypted: string;
  expiresAt: Date;
};

type TwoFactorState = {
  enabledAt: Date | null;
  secretEncrypted: string | null;        // select: false
  backupCodeHashes: string[];            // select: false
  backupCodesGeneratedAt: Date | null;
  backupCodesConfirmedAt: Date | null;
  pendingEnrollment: PendingTwoFactorEnrollment | null; // select: false
};

type UserAuthenticationState = {
  authVersion: number;               // default 1 — fences issued web JWTs
  apiCredentialVersion: number;      // default 1 — fences PAT / OAuth
  mfaFenceVersion: number;           // default 1 — fences in-flight challenges
  passwordResetGeneration: number;   // default 1
  lastUsedTotpStep: number | null;   // monotonic high-water mark, replay defence
  mfaAttempts: {
    windowStartedAt: Date | null;
    count: number;
  };
  mfaChallenges: MfaChallenge[];     // bounded to 5 by $slice; select: false
  twoFactor: TwoFactorState;
};
```

Three separate fences replace what a single version would otherwise have to
do at once, and keeping them separate is what makes the atomic operations in
§5.2–§5.3 possible:

| Field | Incremented by | Answers |
|---|---|---|
| `mfaFenceVersion` | security transitions only — enable, disable, administrator reset, backup-code regeneration, password change, password-reset completion | "has the account's security state moved since this challenge was issued?" |
| `authVersion` | anything that must invalidate issued web sessions | "is this JWT still current?" |
| `lastUsedTotpStep` | a successful TOTP verification | "has this time step already been spent?" |

**A successful login MUST NOT touch `mfaFenceVersion`.** If it did, completing
one challenge would invalidate every sibling challenge issued at the previous
value, and a crash between the User write and the challenge removal would
leave that challenge permanently unverifiable. Replay defence belongs to
`lastUsedTotpStep`, which only ever moves forward and invalidates nothing else.

The existing password field uses `select: false`
(`packages/api/src/models/user.ts:178`). TOTP ciphertext, backup hashes, and
`mfaChallenges` MUST use the same default-exclusion rule and may be selected
only by focused authentication services. Challenge hash fields are never
returned or logged.

Normative invariants:

- All version/generation fields MUST be monotonic integers.
- `mfaFenceVersion` MUST increment in the same conditional mutation that
  enables, disables, resets, or replaces an active factor, regenerates backup
  codes, or completes a password change or reset. Challenge issuance snapshots
  it; no challenge issued before such a transition may verify after it.
- Enabled means `enabledAt != null && secretEncrypted != null`. Partial state
  MUST fail closed.
- `secretEncrypted` and pending ciphertext MUST be supported authenticated
  encryption envelopes. Plaintext or an unknown envelope MUST NOT be treated
  as a valid secret.
- Voluntary pending enrollment expires after ten minutes. Every query checks
  `expiresAt`; nested User fields cannot use a TTL index — the same is true of
  `mfaChallenges`, so expiry is always evaluated at query time.
- A challenge expires after five minutes. Every attempt and consume matches
  `expiresAt > now`. Removal is by `$pull`, so a consumed challenge is absent
  rather than flagged, and single use follows from matching an element that is
  still present.
- `mfaChallenges` is bounded to five elements by `$push` with `$slice: -5`.
  **This bound is not a security control**: issuing a challenge already
  requires a correct first factor, so it constrains only document growth. No
  stronger admission control is required, and none should be added — a
  count-then-insert admission check would be racy across replicas while
  protecting nothing.
- Several unexpired challenges may coexist by design. Issuance never
  supersedes an existing one, because a login in a second tab must not
  destroy the pending challenge of an editor reauthentication holding an
  unsaved buffer (§1.3).
- The attempt budget lives on the User, not on the challenge. Per-challenge
  budgets would let an attacker refresh the budget by starting a new
  challenge.
- `mfaAttempts` is charged **before** the factor is checked, in the same
  conditional update that matches the challenge (§5.2). A replayed
  already-accepted step is therefore charged like any other failure. This is
  deliberate: before verification completes, a replay is indistinguishable
  from an attacker resending a captured code, and exempting it would require
  knowing the matched step before checking it.
- Backup-code confirmation is separate from generation.
  `backupCodesConfirmedAt` proves that the one-time recovery screen was
  acknowledged; recovery-ready administrator checks also require a remaining
  code.
  First-factor account/IP limits and the challenge-slot limit prevent a
  password holder from permanently displacing or locking out a victim.
- Stale challenges and enrollments are removed opportunistically, but expiry
  checks, not cleanup timing, are authoritative.

### §5.2 Spending the attempt budget

The verifier hashes the body token and the binding-cookie secret and resolves
the owning User through a non-unique index on `mfaChallenges.tokenHash`. No
request parameter identifies a User; the 256-bit token does. The index is not
declared unique — uniqueness follows from the entropy, and a unique multikey
index over an array buys nothing here.

The first operation both locates the challenge and spends the account budget,
so that concurrent guesses across replicas are fenced by a single document
write:

```ts
User.findOneAndUpdate(
  {
    mfaChallenges: { $elemMatch: { tokenHash, bindingHash, expiresAt: { $gt: now } } },
    /* budget predicate: window rolled over, or count below cap */
  },
  [ /* pipeline: reset the window if stale, otherwise increment */ ],
  { returnDocument: 'after' },
);
```

`$elemMatch` is normative rather than incidental. Written as three sibling
conditions on `mfaChallenges.*`, MongoDB would be free to satisfy each from a
*different* array element, so an expired challenge's token could pair with a
live challenge's binding hash.

**The budget is charged before the factor is checked, and never refunded.**
Charging first is what makes the fence work: verifying first would let N
parallel requests all read the same pre-decrement budget. Not refunding is
what keeps it implementable — a replayed step cannot be recognised before
verification completes, so an exemption for replays would require knowing the
matched step before checking it. A double-submitted code therefore costs one
attempt, which is immaterial against a cap of five per five-minute window.

Every failure, including an exhausted budget, returns the same generic
envelope. This RFC does not return `429`/`Retry-After`, which would disclose
that a live challenge exists.

### §5.3 Atomic TOTP success

Once the adapter identifies a matching current or previous time step, success
is a single `findOneAndUpdate` that consumes the challenge and advances the
replay mark together:

```ts
User.findOneAndUpdate(
  {
    _id: userId,
    mfaFenceVersion: challenge.fenceVersion,
    mfaChallenges: { $elemMatch: { tokenHash } },
    $or: [{ lastUsedTotpStep: null }, { lastUsedTotpStep: { $lt: matchedStep } }],
  },
  {
    $set: { lastUsedTotpStep: matchedStep, mfaAttempts: { windowStartedAt: null, count: 0 } },
    $pull: { mfaChallenges: { tokenHash } },
  },
  { returnDocument: 'after' },
);
```

Only the request that both finds the challenge still present and advances the
step receives a document, and only that request may mint tokens. Single use
follows from matching an element that is still there and removing it in the
same operation, so concurrent requests yield at most one success without any
reservation protocol. The fence equality is enforced here, where it is
security-critical: a security transition that moved `mfaFenceVersion` after
issue makes the filter fail and no token is minted.

`lastUsedTotpStep` is a high-water mark, not a version. It invalidates nothing
except earlier time steps, so completing one challenge leaves sibling
challenges usable — a login in one tab does not break the editor's pending
reauthentication.

Crash behaviour is bounded in both directions. A crash between §5.2 and this
update spends one attempt and leaves the challenge intact, so the user simply
enters the next code. A crash after this update has already removed the
challenge, so the user restarts the login. Neither outcome mints a token, and
neither can leave a challenge permanently unverifiable.

Forced-setup confirmation uses the same ordering but atomically promotes
`pendingEnrollment`, initializes backup hashes, sets `lastUsedTotpStep`,
increments `authVersion`, clears the enrollment, consumes the challenge, and returns the new
User used for token minting.

### §5.4 Atomic backup-code success

Backup verification uses the same challenge predicates plus:

```ts
{ 'twoFactor.backupCodeHashes': backupCodeHash }
```

Its single update `$pull`s that hash **and** the challenge in one operation
and resets the account attempt budget. One hash can be removed only once, so
concurrent use yields at most one success, and no separate consume step is
needed. A crash after the update loses one backup code but cannot issue
duplicates.

Spending a backup code does **not** increment `mfaFenceVersion`. Consuming a
code is not a security transition — *regenerating* the set is. Bumping the
fence here would invalidate sibling challenges for the same reason §5.3
avoids it.

### §5.5 Activation and password-reset generations

Mail JWT signature and purpose checks remain necessary, but they do not make a
link single-use. Mail token claims gain the User generation and email at issue.

Activation issuance signs `activationGeneration`. Completion is one
conditional User update requiring:

```ts
{
  _id: payload.userId,
  email: payload.email,
  status: STATUS_REGISTERED,
  emailConfirmedAt: null,
  activationGeneration: payload.generation,
}
```

The update sets `emailConfirmedAt`, changes status to active, and increments
`activationGeneration`. Only the winning update emits the existing
`activated` event and enters interactive-auth completion. A token presented
after activation, including a still-unexpired 24-hour link, is rejected and
cannot issue another session. Administrator approval also increments
`activationGeneration`.

**Forgot-password issuance MUST NOT mutate the User.** It signs the
*current* `passwordResetGeneration` into the token and nothing more. The
endpoint is unauthenticated and anti-enumerating by design
(`packages/api/src/hono/handlers/password-reset.ts:38-59`, which today performs
no write at all), so incrementing a generation at issue would let anyone who
knows an address invalidate that account's outstanding link — an email-only
denial of service introduced by the fix rather than by the defect. Multiple
outstanding links therefore remain valid until one is consumed; they all
arrive in the same mailbox, so this costs nothing.

Reset completion computes the new password hash, then conditionally updates
the active User by id, email, and generation. The same update:

- writes the new password hash;
- increments `passwordResetGeneration`, `authVersion`, and `mfaFenceVersion`;
  the last of these invalidates outstanding challenges; and
- preserves TOTP enrollment.

Only that update consumes the reset credential — which also closes a current
defect: today's completion handler records no consumption at all, so the same
reset JWT works repeatedly for its full one-hour lifetime
(`packages/api/src/hono/handlers/password-reset.ts:73-107`,
`packages/api/src/util/mail-token.ts:28-33`). Preflight may validate a
generation without consuming it, but the password write cannot occur twice.

**When the account has MFA enabled, completion does not write the password.**
It stages the computed hash in a `purpose: 'password_reset'` challenge
(`stagedPasswordHash`, §5.1) and returns a challenge token. The mutation above
happens only inside §5.3's success update, extended to apply the staged hash.
Mailbox compromise alone therefore cannot take over an enrolled account — and,
just as importantly, cannot lock its owner out either, because nothing is
mutated until the second factor succeeds. Today's handler signs the user
straight in on completion (`password-reset.ts:102`); under MFA that issuance
moves behind the factor.
Administrator password reset, administrator email change, confirmed
self-service email change, suspension, and deletion MUST increment
`passwordResetGeneration`, so every older reset link becomes stale.
The self-service email-confirmation mutation is a Phase 1 integration point:
its conditional email update MUST increment that generation and its tests MUST
prove a reset link issued before the email change cannot be consumed.

## §6 TOTP, backup-code, and encryption profile

### §6.1 TOTP profile

| Parameter | Value |
|---|---|
| Secret | At least 20 random bytes, Base32 encoded |
| Algorithm | HMAC-SHA-1 |
| Digits | 6 |
| Period | 30 seconds |
| Accepted steps | Current step and previous one step |
| Future steps | Never accepted |

SHA-1 is used inside standardized HMAC-based TOTP for authenticator
compatibility; it is not used as a password hash. RFC 6238 recommends a
30-second step, permits a bounded transmission delay, and forbids accepting
the same OTP again after successful validation.

Many libraries interpret `window: 1` as previous/current/future. Crowi's
window is asymmetric (`-1/0`). The adapter MUST evaluate current and previous
counters explicitly if the selected library cannot express that window
without accepting a future counter.

API and database hosts MUST use reliable NTP synchronization. Clock skew is
not addressed by widening the accepted future window.

### §6.2 Backup codes

Enrollment and regeneration produce exactly ten codes. Each code encodes at
least 128 random bits. A suitable representation is unpadded Base32 of 16
random bytes, grouped only for readability.

Canonicalization is narrow: remove Crowi-inserted separators and ASCII
whitespace, then uppercase. It MUST NOT map look-alike characters. MongoDB
stores only `SHA-256(canonicalCode)`.

The status API returns only the remaining count. Plaintext codes are returned
once after setup or regeneration with `Cache-Control: no-store`. The UI
supports copy, download, and print without sending codes to another service.
At three or fewer codes it prominently recommends regeneration.

Regeneration requires current password and TOTP, atomically replaces the
complete set, clears the confirmation timestamp, invalidates the pending
challenges, and increments `authVersion` and `mfaFenceVersion`. Existing
PAT and OAuth credentials remain valid.

### §6.3 Encryption boundary

`packages/api/src/util/crypto.ts` exposes AES-256-GCM encryption for arbitrary
UTF-8 values and reads a base64 32-byte `CROWI_ENCRYPTION_KEY`
(`packages/api/src/util/crypto.ts:18-36,68-105`). The factor service reuses
that primitive and key provider.

This reuse is deliberately stricter than Config persistence:

- Enrollment MUST call `isEncryptionConfigured()` and return
  `503 TWO_FACTOR_ENCRYPTION_UNAVAILABLE` when false.
- A secret MUST be encrypted before it reaches a Mongoose write.
- The service MUST require `isEncrypted(value)` before decryption. It MUST
  reject plaintext even though generic Config compatibility permits plaintext
  (`packages/api/src/models/config.ts:133-141`).
- Malformed envelopes, authentication-tag failures, and wrong keys MUST fail
  closed. They MUST NOT disable TOTP or issue a password-only session.
- All API replicas MUST use the same key, backed up separately from MongoDB.

Once any User is enrolled, `CROWI_ENCRYPTION_KEY` is load-bearing: removing,
changing, or rotating it is forbidden without the rotation procedure. Rotation
requires a versioned keyring envelope first: keep old and new keys on every
replica, conditionally re-encrypt every selected User active/pending secret
under its generation fence, verify completion, then remove the old key. The
Config-only re-encrypt endpoint is not adequate. Until that migration exists,
rotation/removal is prohibited rather than silently reducing users to backup
codes or operator reset.

If the active secret cannot be decrypted, backup-code verification remains
available because it uses hashes. Otherwise administrator or operator reset
is required. Global enforcement cannot be enabled while encryption is
unavailable.

## §7 Pending-cookie protocol and interactive flows

### §7.1 Two-part pending transport

A pending authentication is carried by two values that must both be presented,
and that are deliberately held in different places:

1. **The challenge token** — 32 random bytes, returned once in the `202` body,
   held by the initiating client **in memory only**. It identifies *which*
   challenge is being answered.
2. **The browser-binding secret** — carried in an `HttpOnly` cookie, one per
   browser rather than one per challenge. It proves the answer comes from the
   browser the challenge was issued to.

Splitting the two is what makes parallel challenges representable at all. A
cookie is keyed by name, path and domain, so a second `Set-Cookie` with the
same name **replaces** the first: a design that puts the challenge identity in
the cookie can never hold two live challenges, and the second tab silently
destroys the first tab's pending login. Because the editor's inline
reauthentication is exactly such a "first tab", and it is holding an unsaved
buffer (§1.3), that failure is not acceptable. Moving the identity into the
response body gives each client its own token, while the one thing that
genuinely is per-browser — the binding — stays in the one place a script
cannot read.

The binding cookie MUST be:

- `HttpOnly`;
- `Secure` in production (local HTTP development may omit it);
- host-only, with no `Domain`;
- scoped to the narrowest common auth route path;
- `SameSite=Strict`; and
- rotated no less often than the longest challenge lifetime.

It is cleared on logout. It is **not** cleared when a single challenge
succeeds, expires or is cancelled, because it is shared by every challenge in
that browser — clearing it would break the sibling challenges this design
exists to support.

Every endpoint that issues or consumes a pending challenge MUST:

- require an exact allowed `Origin`, rejecting missing or `null` Origin for
  browser flows;
- require `Content-Type: application/json`;
- require the challenge token in the request **body**, never in a cookie or
  query string; and
- return `Cache-Control: no-store`.

No separate CSRF nonce is needed. The classic double-submit pattern exists to
give the server a value the attacker's site cannot read; here the challenge
token already is that value, and it is strictly stronger than a nonce echoed
from a cookie, because it never travels in a cookie at all. A cross-site page
can cause the binding cookie to be sent — though `SameSite=Strict` already
prevents that — but it cannot obtain the token, and without the token the
request matches no challenge. `X-Crowi-Preauth-CSRF` and the corresponding
CORS allowlist entry are therefore not introduced.

**What this does not defend against, stated plainly.** Script executing on the
Crowi origin can read the token from the page and reach the API with the
binding cookie attached. That is not a weakness of this transport: the same
script can already read the final access and refresh tokens out of
`localStorage` (`packages/web/src/lib/auth-token.ts:28,36`). **A
pre-authentication transport cannot be made stronger than the credential it
guards.** Claiming that an `HttpOnly` cookie "protects the challenge from XSS"
would be false while the session it leads to is not similarly protected.
Origin-level containment of active content is a real and separate concern,
addressed in §12.2; it is not a precondition this RFC can discharge, and
withholding MFA does not improve it.

This RFC supports same-origin browser/API deployment. A future split-origin
design MUST centrally set `credentials: 'include'` on the client, define
`SameSite=None; Secure` with exact CORS
(`packages/api/src/hono/middleware/cors.ts:80-89` already permits
credentials), and add a real-browser integration test proving both
`Set-Cookie` retention and binding-backed verification. It is not supported
merely by documenting a MUST.

### §7.2 Central completion service

Every interactive issuer calls one service:

```ts
type InteractiveAuthCompletion =
  | { kind: 'tokens'; tokens: TokenPair }
  | {
      kind: 'two_factor_required';
      expiresIn: number;
      methods: ('totp' | 'backup_code')[];
      challengeToken: string;
    }
  | {
      kind: 'two_factor_setup_required';
      expiresIn: number;
      challengeToken: string;
    };
```

The browser-binding cookie is set through the Hono response; the challenge
token is returned in this object and held in client memory (§7.1). The service receives the User, purpose, authentication source,
first-factor methods, and browser Origin. It is the only production path that
may call web `generateTokens()` after interactive authentication. An
architecture test enumerates production token-issuance call sites.

### §7.3 Password login and public verification

`POST /auth/login` keeps the current generic invalid-credentials response.
After a correct password:

- no enrolled/required factor: return the existing `200` final-token response;
- enrolled: ensure the binding cookie and return `202`:

```json
{
  "status": "two_factor_required",
  "expiresIn": 300,
  "methods": ["totp", "backup_code"],
  "challengeToken": "<opaque-32-byte-token>"
}
```

- required but unenrolled: ensure the binding cookie and return `202`:

```json
{
  "status": "two_factor_setup_required",
  "expiresIn": 300,
  "challengeToken": "<opaque-32-byte-token>"
}
```

`POST /auth/two-factor/verify` accepts:

```json
{
  "challengeToken": "<opaque-32-byte-token>",
  "method": "totp",
  "code": "123456"
}
```

The body token identifies which pending challenge is being answered and the
binding cookie proves it is the issuing browser; both are required (§7.1).
`method` is explicit and the server does not infer recovery intent from code
shape. Successful verification
returns the existing final token-and-user response. Wrong, unknown, expired,
consumed, and locked challenges use a generic error and do not reveal
enrollment, remaining attempts, account existence, or budget state. The verify
endpoint intentionally does not return `429` or `Retry-After`, since that
would disclose a live challenge.

### §7.4 Shared web login helper and inline editor reauthentication

`loginWithPassword` becomes a discriminated helper:

```ts
type LoginResult =
  | { kind: 'authenticated'; username: string }
  | { kind: 'two_factor_required'; methods: TwoFactorMethod[]; challengeToken: string }
  | { kind: 'two_factor_setup_required'; challengeToken: string }
  | { kind: 'error'; message: string };
```

It stores tokens only for the final `200` response. The `challengeToken` MUST
be held in component state for the lifetime of the flow and MUST NOT be
written to `localStorage`, `sessionStorage`, a cookie, or the URL — its
in-memory lifetime is what keeps it out of any store that survives the tab. A
companion verify helper posts the token in the request body, receives final
tokens, and then calls the same `storeTokens()` path.

Because the token lives in component state rather than in one shared cookie,
two components can hold two different pending challenges at once without
either being aware of the other. That is precisely what the next paragraph
depends on.

The public login form changes from password state to factor state in place.
The editor's `SessionReauthModal` does the same inside its existing Dialog:

1. submit email and password;
2. if challenged, replace the password fields with TOTP input and a backup
   code switch without closing the Dialog;
3. call the verify endpoint with the token it holds in its own state;
4. store final tokens;
5. call `resolveReauth()` to refetch collab and presence tokens; and
6. keep the editor route, Y.Doc, and CodeMirror instance mounted throughout.

A login started in another tab while this modal is open creates a *separate*
challenge and leaves the modal's own challenge untouched (§4.1, §5.1). This is
the concrete reason the transport is split the way §7.1 describes: with the
challenge identity in a shared cookie, that second tab would have silently
invalidated the modal's pending login and the only recovery would have been to
navigate — discarding the buffer.

If the modal's challenge is nevertheless gone — it expired, or five newer
challenges evicted it from the bounded array — the modal shows the generic
pending/expired state and returns to its password step. It still does not
navigate. "Discard and go to login" remains the only route that knowingly
abandons the unsaved buffer.

### §7.5 Voluntary enrollment

All `/me/two-factor` endpoints require a final web access JWT in the
`Authorization` header. PAT, OAuth, and access-cookie-only authentication are
rejected. `AuthContext` MUST record credential provenance (`authorization`,
`access-cookie`, `pat`, `oauth`), and `createJwtAuth` plus its handler contract
MUST expose it; handlers reject any provenance other than `authorization`.
State-changing endpoints require an exact allowed Origin. Until that middleware
change ships, these endpoints MUST NOT ship, because the current cookie fallback
is ambient and indistinguishable from header authentication.

> **Update (feature-auth-cookie-fallback-scope)**: the credential-provenance
> primitive this section requires now exists. `AuthContext`'s `web` variant
> (`packages/api/src/hono/middleware/auth.ts`) carries `via: 'header' |
> 'cookie'`, and `kind` already separates `web` / `oauth` / `pat`, so the four
> buckets this section asks for map directly: `authorization` = `{ kind:
> 'web', via: 'header' }`, `access-cookie` = `{ kind: 'web', via: 'cookie'
> }`, `pat` = `{ kind: 'pat', … }`, `oauth` = `{ kind: 'oauth', … }`. Separately
> — and independent of the above — `createJwtAuth`'s default cookie fallback
> is now header-only everywhere except the three headerless attachment
> delivery routes (`createAttachmentAuth`), so the "ambient and
> indistinguishable" cookie-fallback risk this section calls out no longer
> applies to `/me/*` at all: a cookie-only request to `/me/two-factor` is
> already a 401 before an endpoint would even need to check `via`. This spec
> does **not** implement `/me/two-factor` itself (no 2FA endpoints exist yet)
> — it only lands the provenance field and the header-only default this
> section's Origin-check gate was written to require before that endpoint
> family could ship.

Flow:

1. `GET /me/two-factor` returns `enabled`, `enabledAt`,
   `backupCodesRemaining`, `backupCodesConfirmed`, and policy state.
2. `POST /me/two-factor/setup` with `{ password }` verifies the current
   password, requires encryption readiness, generates and encrypts a pending
   secret, and returns `{ otpauthUri, manualEntrySecret, expiresAt }` once.
3. `POST /me/two-factor/setup/confirm` with `{ code }` verifies current or
   previous step, atomically promotes the secret, initializes
   `lastUsedTotpStep`, generates ten backup hashes, invalidates pending
   authentication, increments `authVersion`, and returns backup codes plus a
   fresh version-matching token pair.
4. `POST /me/two-factor/backup-codes/acknowledge` records that the recovery
   screen was saved.
5. `POST /me/two-factor/backup-codes/regenerate` requires password plus TOTP,
   replaces the set, increments `authVersion`, and returns the new codes and a
   fresh pair.
6. `DELETE /me/two-factor` requires password plus TOTP or one backup code,
   clears factor state, invalidates pending authentication, increments
   `authVersion`, and signs the browser out.

Self-disable is forbidden while global enforcement applies.

### §7.6 Forced enrollment

A setup-required challenge is not an authenticated session and cannot call
normal `/me` routes. Dedicated endpoints consume the pending cookie:

- `POST /auth/two-factor/setup/start`; and
- `POST /auth/two-factor/setup/confirm`.

Start creates an encrypted pending secret and returns the one-time
`otpauthUri` and manual secret. Confirm verifies the first TOTP and atomically
promotes the enrollment, sets replay state, initializes ten backup hashes,
increments `authVersion`, consumes the challenge, and returns backup codes and
fresh final tokens.

The setup challenge grants no access to pages, profile data, PATs, OAuth
consent, admin routes, or any other protected resource.

### §7.7 Password reset, activation, and invitation

Password reset follows §5.5. After the atomic password/session-generation
update:

- enrolled user: create a `password_reset` challenge; no tokens before factor
  verification;
- unenrolled user under required policy: create a `policy_setup` challenge;
- unenrolled user with policy off: issue final `recovery` web tokens.

Activation and invitation use the central completion service. Under required
policy they enter forced setup; otherwise a newly activated account receives
final tokens. Activation must first win the generation/state consume in §5.5.

### §7.8 Refresh

Final web JWTs carry:

```ts
{
  userId: string;
  email: string;
  type: 'access' | 'refresh';
  authVersion: number;
  amr: ('pwd' | 'otp' | 'recovery' | 'activation' | 'invite' | 'federated')[];
  authTime: number;
}
```

`authTime` is the Unix time of the last interactive authentication or explicit
step-up. Refresh preserves `authTime` and `amr`; it never converts an old
session into recent authentication.

Refresh loads the User and requires exact `authVersion`. A mismatch is `401`,
not a new challenge. The browser clears final tokens and starts full login;
inside an editor, the existing inline reauthentication modal handles that
login without navigation.

## §8 Session and credential invalidation

### §8.1 Web-session fence

`createJwtAuth` already loads the User for every accepted credential
(`packages/api/src/hono/middleware/auth.ts:154`), which today checks only
`status`. Web session tokens gain an `av` claim carrying `authVersion` at
issue; the middleware compares it against the loaded User and refresh performs
the same comparison. No additional query is introduced.

There is **no session-revocation mechanism in the codebase today** —
`authVersion`, `passwordChangedAt` and equivalents are all absent — so this is
new infrastructure rather than a change to an existing fence. Tokens minted
before the claim exists carry no `av` and are refused, which signs every user
out once at the upgrade. Under the alpha no-back-compat policy that is
acceptable, but it is an operational event and belongs in the release notes.

The following operations increment `User.authVersion`:

- TOTP enable;
- TOTP disable;
- backup-code regeneration;
- password reset completion;
- **self-service password change**;
- administrator password or email change; and
- administrator or operator TOTP reset.

Global policy enablement is deliberately **absent** from that list. It is
enforced by the epoch claim of §11.4, which is O(1) and immediate; bumping
`authVersion` per user would be an O(N) write that still leaves a window.

Self-service password change is on the list because it is a live defect
rather than a new requirement: `packages/api/src/hono/handlers/me.ts:409-423`
calls `updatePassword` and returns without touching any version or session, so
today "change my password because I think I am compromised" does not evict the
attacker. That handler MUST, in one conditional update, increment
`authVersion`, `passwordResetGeneration` and `mfaFenceVersion`, and MUST
return a fresh token pair so the acting tab is not signed out. Per the
credential-scope decision, PAT and OAuth credentials survive.

Each of these operations also increments `mfaFenceVersion`, so any
`mfaChallenges` element issued beforehand fails the §5.3 success filter.
Access and refresh JWTs become invalid immediately; no operation relies on
natural expiry.

Enrollment confirmation and backup regeneration MUST return a fresh pair whose
`authVersion` is the post-update value. The client cancels/serializes
authenticated background requests and suppresses the global refresh-expiry
handler for this mutation, stores the replacement pair, then resumes queries.
Thus a stale refresh cannot clear tokens or redirect before one-time backup
codes are displayed. Disable and recovery do not issue a pair.

### §8.2 API-credential fence

Routine TOTP maintenance must not unexpectedly stop CLI, MCP, or automation.
Administrator recovery, by contrast, represents suspected compromise and
must revoke all credential families. Crowi therefore adds
`User.apiCredentialVersion`:

- OAuth access JWTs carry it;
- PAT and OAuth refresh records store their issue version;
- authorization-code and device-code records store it when approved;
- PAT/OAuth authentication compares it with the current User; and
- authorization/device-code exchange compares it before minting.

Administrator and operator recovery increment `authVersion` and
`apiCredentialVersion` in the same User update before best-effort row cleanup.
Already-issued stateless OAuth access JWTs are rejected by the version fence.

| Operation | Web access/refresh JWT | PAT/OAuth |
|---|---|---|
| Self enable, disable, regeneration | Revoke immediately | Preserve |
| Password reset or ordinary email/password maintenance | Revoke immediately | Preserve |
| Global policy enablement | Revoke affected local-password sessions | Preserve |
| Administrator/operator recovery | Revoke immediately | Revoke immediately |

### §8.3 WebSocket authorization and recovery completion

Collab, presence, and notification tokens gain the current web
`authVersion`. Connection authentication compares it with User state. Each
attached server also gains a process-local:

```ts
disconnectUser(userId: string): Promise<void>
```

handle. The current public handles expose shutdown and, for collab,
page invalidation, but no per-user disconnect
(`packages/api/src/collab/attach.ts:39-67`;
`packages/api/src/presence/attach.ts:48-56`;
`packages/api/src/notifications/attach.ts:42-50`).

Every protocol MUST enforce `authVersion` for an established connection, not
only at connect: notifications require a periodic server-side revalidation,
and collab/presence require an authenticated periodic revalidation before
continuing to stream or accept work. On mismatch they close the connection.

**Administrator recovery completes when the Mongo write commits.** It is not
gated on socket delivery, and it MUST NOT be reported as unavailable because
Redis is absent. Making recovery depend on Redis would contradict §4.4 — which
rejects Redis precisely because it is optional — and would deny the recovery
path to exactly the single-instance operators least able to work around it.
Redis-less single-instance operation is explicitly supported
(`packages/api/src/collab/attach.ts:239-253`;
`packages/api/src/notifications/attach.ts:87-92`).

`disconnectUser` is therefore a **best-effort accelerator, not a barrier**. It
always runs on the local replica; with Redis it also fans out to the others.
Where it does not reach, the residual exposure is bounded by two independent
limits: an established socket is re-checked at the next revalidation tick, and
it was admitted by a wsToken whose lifetime is five minutes
(`packages/api/src/util/ws-token.ts:20`). A revoked user therefore loses
realtime access within that bound, and loses HTTP access at the very next
request. New connections are refused immediately by the version fence.

This is a deliberate trade of instantaneous socket teardown for a recovery
path that works in every supported topology. The bound is small, it is stated
rather than assumed, and the alternative — an unavailable "reset" button
during an account compromise — is worse. The DB-direct admin CLI, which has no
process-local handles at all (§11.3), relies on exactly this property.

### §8.4 Rollout

RFC-0008 performs a blocking boot migration that adds explicit default
versions and two-factor state. Deployment then has two stages:

1. all token minters add version claims while verifiers temporarily tolerate
   only the migration's explicit version-1 rows; and
2. after old replicas are drained, strict claim verification is enabled and
   old claim-less tokens are rejected.

No permanent missing-claim fallback remains after cutover. Existing PAT and
OAuth records are backfilled with issue version 1.

## §9 Abuse, replay, and logging controls

### §9.1 MongoDB is authoritative

The hash-indexed challenge allows at most five submitted codes per challenge
and the User account window allows at most five submissions per five minutes.
The hash-addressed conditional fence described in §5.2 is authoritative.
These controls work on every API replica and after process restart.

The existing rate-limit utility uses Redis when available, an in-memory map
otherwise, and fails open on Redis errors
(`packages/api/src/util/rate-limit.ts:13-26,87-123`). It may add:

- an earlier challenge/account rejection; and
- an IP budget initially set to 25 attempts per five minutes.

Neither is authoritative. The IP bucket uses the direct peer address unless a
configured trusted-proxy policy identifies a forwarded header and hop. Shared
NAT users receive short `Retry-After` windows; an IP bucket never permanently
changes User state.

First-factor password and reset-link endpoints also require account/IP rate
limits before expensive password hashing or challenge churn. Their exact
Mongo representation belongs to the Phase 1 implementation spec; second-factor
correctness does not depend on Redis or those auxiliary IP limits.

### §9.2 Replay

TOTP success requires `matchedStep > lastUsedTotpStep` in the same update that
consumes the challenge. The first confirmation code initializes
`lastUsedTotpStep`, so it cannot immediately be reused for login.

Backup codes are removed by hash in the same update that consumes the
challenge. Redis stores neither replay state nor backup state.

### §9.3 Credential redaction

Passwords, TOTP values, backup codes, TOTP secrets, `otpauth` URIs, pending
cookie values, CSRF nonces, PATs, OAuth tokens, and their request bodies MUST
be excluded from:

- application debug logs;
- access-log URLs and query strings;
- structured request-body logging;
- APM spans and error objects;
- analytics events; and
- security-event metadata.

The current password verifier logs legacy password hash material
(`packages/api/src/models/user.ts:322-335`). TOTP implementation MUST NOT copy
that posture, and the password logging should be removed when this
authentication boundary is implemented.

## §10 QR provisioning and web UX

### §10.1 URI ownership and QR rendering

The API generates the secret and canonical URI:

```text
otpauth://totp/<issuer>:<account>?secret=<BASE32>&issuer=<issuer>&algorithm=SHA1&digits=6&period=30
```

The issuer is the Crowi instance display name and the account is the User
email. Label and query components are percent-encoded, and the label issuer
matches the `issuer` query parameter.

The browser renders the URI locally with a small QR library. It does not
implement TOTP and does not receive a TOTP verification library. Browser-local
rendering is selected because:

- manual entry already requires returning the secret;
- a server PNG/SVG endpoint adds a secret-bearing cache and log surface; and
- an external QR service would disclose the secret to a third party.

No external QR service is permitted. URI and secret stay in component memory,
not localStorage, sessionStorage, a URL, analytics, or a server-rendered cache.

### §10.2 Login and recovery UX

The public login page and editor modal share factor components:

- a six-digit input with paste and `autocomplete="one-time-code"`;
- an explicit “use a backup code” switch;
- no remaining-attempt disclosure;
- a generic expiry/invalid response; and
- a return to the password step when the challenge expires.

The `/me` settings area adds “Two-factor authentication” with:

1. current-password confirmation;
2. QR plus manual-entry secret;
3. first-code verification;
4. one-time backup-code display with copy/download/print; and
5. explicit recovery-code acknowledgment.

Closing the recovery screen before acknowledgment leaves TOTP enabled but the
User is not recovery-ready. Codes cannot be fetched again; the User can
authenticate with TOTP and regenerate them.

## §11 Administrator recovery, operator break-glass, and enforcement

### §11.1 Administrator reset

Phase 2 adds:

```text
DELETE /admin/users/{id}/two-factor
```

with a required human-readable reason. It is mounted behind
`createJwtAdminRequired`; the existing admin users surface already uses that
boundary (`packages/api/src/hono/handlers/admin/users.ts:100-105`).

Additional requirements:

- The caller uses a final web session with recent TOTP/backup assurance.
- PAT, OAuth, and cookie-only access-token authentication are rejected.
- The caller cannot target their own User id.
- A singleton `TwoFactorRecoveryGuard` lease serializes reset and enforcement
  operations. While held, its conditional count predicate proves that at least
  one other active recovery-ready administrator remains; read-then-write
  checks are forbidden.
- A durable `SecurityOperation` with random operation id is inserted as
  `pending` before mutation; it is not yet an authoritative reset event.
- One atomic User update clears active/pending TOTP state and the challenge,
  increments both credential versions, increments password-reset and
  activation generations, and increments `mfaFenceVersion`.
- The conditional User mutation records that operation id. The operation is
  then conditionally changed to `succeeded` and emits the authoritative
  `two_factor.admin_reset` event; failed/unknown operations are explicitly
  `failed`/`pending`, never presented as resets.
- PAT/OAuth cleanup and the connection-ack barrier follow the User fence. A
  retry with the same operation id is idempotent; a reconciler completes the
  state transition from the User operation marker or marks a never-mutated
  operation failed.
- The event records actor, target, time, reason, correlation id, outcome, and
  sanitized metadata, never factor or credential material.

When enforcement is active, the target's next local-password sign-in enters
forced setup.

### §11.2 Recent-MFA step-up

`POST /auth/two-factor/step-up` accepts a current final web JWT and creates a
`step_up` pending cookie. Verification returns a replacement pair with
`authTime = now` and `amr` containing `otp` or `recovery`.

`requireRecentMfa(maxAgeSeconds)` is a shared guard for administrator reset,
policy enablement, PAT issuance, and later sensitive actions. It requires:

- header-based current-version web JWT;
- `amr` containing `otp` or `recovery`; and
- `authTime >= now - maxAgeSeconds`.

The initial maximum age is ten minutes.

### §11.3 Operator break-glass

Phase 1 adds a DB-direct command to the existing operator package:

```text
crowi-admin two-factor reset --user <email> --reason <text>
```

`@crowi/admin-cli` is a server-side direct-Mongo tool
(`packages/admin-cli/src/cli.ts:16-30`; RFC-0012). It is the recovery boundary
when no web administrator can authenticate.

The command:

- requires an exact-email confirmation, or explicit `--yes` in a documented
  incident procedure;
- requires a non-empty reason;
- creates the same durable pending `SecurityOperation` and completes the same
  conditional outcome protocol as the web path;
- performs the same atomic credential-version and factor-state reset as the
  web administrator path;
- works without Redis and without decrypting the old TOTP secret;
- may reset the sole administrator;
- records host and OS operator identity when available; and
- notifies the target when mail is operational.

There is no hidden master backup code, global bypass token, magic environment
variable, or unaudited direct-update instruction.

The operations guide covers device loss, exhausted codes, sole administrator,
encryption-key loss/mismatch, container execution, event verification, and
credential-revocation verification.

### §11.4 Global enforcement

Phase 3 adds a dedicated transition endpoint, not a field on the whole-object
`PUT /admin/security` surface, whose existing mixed durable/best-effort writes
cannot safely round-trip this policy:

```text
security:twoFactorRequired = boolean (default false)
```

It applies to interactive local-password authentication. Federated
authentication is exempt. PAT, OAuth, MCP, and CLI requests are not challenged.

Before enablement, while holding the `TwoFactorRecoveryGuard` lease:

- `CROWI_ENCRYPTION_KEY` is usable;
- the actor has recent MFA;
- at least two active administrators are recovery-ready;
- the actor is one of them; and
- the guard's conditional aggregate proves two active recovery-ready admins;
  concurrent enablements or reciprocal resets cannot pass separately.

Enablement is a **single Config write of a monotonic integer**, and enforcement
is a claim comparison. There is no bulk `authVersion` rewrite, no transition
record, and no window in which already-issued tokens keep working:

```text
security:mfaPolicyEpoch = integer (monotonic, incremented on every enablement)
```

Every issued web session token carries two claims it does not carry today
(`packages/api/src/util/jwt.ts:15-28` currently emits only `userId`, `email`
and `type`):

- `mpe` — the value of `mfaPolicyEpoch` at issue; and
- `amr` — how the session was authenticated: `['pwd']`, `['pwd','otp']`, or
  `['ext']` for federated.

The authenticated-request middleware rejects a web session token when `amr`
contains neither `otp` nor `ext` and `token.mpe < mfaPolicyEpoch`, returning
`403` with `MFA_SETUP_REQUIRED`, which the web app routes to forced setup.
**This costs nothing**: the middleware already loads the full User on every
authenticated request (`packages/api/src/hono/middleware/auth.ts:154`), and
the same place compares `av` against `authVersion`.

An **integer** epoch rather than an enabled-at timestamp is deliberate. A
timestamp comparison against `iat` would depend on clock agreement between the
replica that issued a token and the replica that checks it; a monotonic
counter has no such dependency.

The property this buys is the one the batch design could not provide: a token
minted one second before enablement is refused one second after it. Under a
per-User batch, that token keeps reaching protected routes until its owner's
batch runs — and, because the middleware consults only the User document, no
amount of care in the issuance path closes that hole.

The honest residual is cache propagation, not correctness. `mfaPolicyEpoch` is
read through the config cache, so a replica that has not yet observed the new
value enforces *late*, never wrongly — the epoch only ever increases, so a
stale reader under-enforces for the refresh interval and then catches up.
Config already propagates over Redis pub/sub
(`packages/api/src/service/config.ts:222-223`), and multi-replica deployment
already requires Redis for unrelated reasons, so the interval is short. A
single instance is its own writer and has no interval at all.

After enablement, enrolled Users complete password plus factor; unenrolled
Users enter forced setup. Self-disable is forbidden. Disabling the global
policy stops forcing new enrollment, preserves every individual TOTP
configuration, and does **not** decrement the epoch — sessions already issued
under the policy stay valid, and a later re-enablement increments again.

The implementation records whether an account has a usable local password, so
that federated-only Users are exempt by their `amr` rather than by a scan.
Role-based enforcement and grace periods require a later RFC.

### §11.5 Preventing administrator lockout

| Failure | Prevention/recovery |
|---|---|
| One administrator enables enforcement and loses the only device | Enablement requires two active recovery-ready administrators. |
| Backup codes were not saved | `backupCodesConfirmedAt` is required for recovery-ready status. |
| Backup codes are exhausted | Remaining count and regeneration are available; zero codes clears recovery-ready status. |
| One administrator loses the device | Another recently MFA-authenticated administrator performs reset. |
| An administrator tries to reset themselves | The endpoint rejects self-targeting. |
| Reset would remove the last other recovery-ready administrator | The endpoint rejects it. |
| The sole administrator loses all factors | The DB-direct operator command resets the account and credentials. |
| The encryption key is lost | Backup codes remain usable; otherwise restore the key or run operator reset. |

## §12 Security and failure considerations

### §12.1 Authentication boundary

- First-factor success MUST NOT create an access JWT, refresh JWT, access
  cookie, authenticated localStorage entry, OAuth consent session, or PAT.
- The pending cookie MUST NOT be accepted by `createJwtAuth`, OAuth, MCP, or
  any normal protected route.
- Factor success mints a fresh final pair; it does not upgrade a pending value.
- Every protected web request and refresh checks `authVersion`.

### §12.2 CSRF, XSS, transport, and cache

- Pending authentication requires a body-borne challenge token that a
  cross-site page cannot read, so CSRF is defeated by the transport itself;
  exact Origin checks and `SameSite=Strict` on the binding cookie are defence
  in depth rather than the primary control (§7.1).
- Sensitive authenticated factor changes require an exact Origin and a
  provenance-checked header-based final web JWT. They reject access-cookie
  fallback through the extended `AuthContext`, so their credential is
  non-ambient and cannot be supplied by a cross-site form.
- HTTPS is mandatory in production.
- Secret- or challenge-bearing responses use `Cache-Control: no-store`.
- Passwords, codes, secrets, and challenge tokens never appear in URLs.

**Origin compromise, stated without overclaiming.** Same-origin script can
read the challenge token from memory and can cause the binding cookie to be
sent. It can equally read the final access and refresh tokens out of
`localStorage` (`packages/web/src/lib/auth-token.ts:28,36`). The pre-auth
transport is therefore exactly as strong as the session it produces, and no
arrangement of `HttpOnly` changes that while the session itself is script
readable.

The consequence is that origin containment is a **parallel** workstream, not a
gate on this one. Making MFA wait for it would leave accounts with one factor
in the meantime, which is strictly worse, and would misattribute an origin
weakness to the feature that merely shares the origin. The current renderer
permits active HTML and the app ships no CSP, so the following remain open on
their own track: sanitising Markdown to remove active-content capability, and
adding a restrictive CSP. One concrete leg has already closed — attachment
delivery no longer honours a client-declared `Content-Type`, and inline
responses carry `nosniff` and a sandbox CSP — which removed a stored-XSS path
that would have read those same tokens.

TOTP is not a defence against origin compromise, and this RFC does not present
it as one.

### §12.3 Secret compromise and key failure

- A database dump without `CROWI_ENCRYPTION_KEY` does not reveal TOTP secrets,
  backup codes, or pending-cookie values.
- Missing or wrong keys never degrade to password-only login.
- Backup-code verification may continue if TOTP decryption fails.
- A compromised application host that can read the key is inside the verifier
  trust boundary.

### §12.4 Availability and partial failure

| Failure | Required behavior |
|---|---|
| Mongo unavailable before factor completion | Fail closed; issue no tokens. |
| Redis absent or unavailable | Continue with Mongo challenge/account controls. |
| Stale challenge/enrollment remains | Query-time expiry rejects it. |
| Crash after User TOTP update before challenge consume | No token; OTP is spent but a later code can consume the challenge. |
| Crash after atomic backup success | No token; one backup code is spent. |
| Encryption unavailable during setup | Deterministic 503; persist no plaintext. |
| Notification failure | Authentication/reset remains successful; log sanitized failure. |
| Admin cleanup or Redis publish fails after version fence | Old credentials remain rejected; event records repair state. |
| Policy transition stops | Local-password issuance remains fail-closed until idempotent resume. |
| Activation link is replayed | Status/generation predicate rejects it before token issuance. |
| Password-reset link is replayed | Generation predicate rejects it before password or token side effects. |

### §12.5 Enumeration and denial of service

Password login retains generic invalid credentials. Challenge errors do not
reveal account existence, enrollment, backup-code availability, or attempts
remaining.

An attacker without the first factor cannot obtain a targeted challenge. A
password holder is also in scope: challenge slots prevent superseding a
victim's live login, first-factor account/IP limits bound issuance, and a
replayed already-accepted TOTP does not spend the account budget. A stolen
pending cookie still requires its CSRF nonce, the second factor, and the
five-minute TTL.

### §12.6 Dependency review

The implementation may use `otplib` for server-side TOTP and `qrcode` for
browser-local rendering. The implementation spec must pin and review versions
for:

- maintenance and license;
- Node/browser compatibility and module format;
- constant-time comparison behavior;
- secret-generation entropy;
- asymmetric-window semantics;
- URI/QR correctness; and
- browser bundle size.

No TOTP verifier ships to the browser, and no QR service receives a secret.

## §13 API contract and OpenAPI effects

| Method/path | Authentication | Purpose |
|---|---|---|
| `POST /auth/login` | Public first factor + exact Origin | Existing success or cookie-backed `202` union. |
| `POST /auth/two-factor/verify` | Pending HttpOnly cookie + CSRF header | Complete TOTP/backup challenge. |
| `POST /auth/two-factor/step-up` | Header-based final web JWT | Create recent-MFA pending challenge. |
| `POST /auth/two-factor/setup/start` | Pending cookie + CSRF header | Begin forced enrollment. |
| `POST /auth/two-factor/setup/confirm` | Pending cookie + CSRF header | Confirm forced enrollment and issue final tokens. |
| `GET /me/two-factor` | Final web JWT | Status and backup-code count. |
| `POST /me/two-factor/setup` | Final web JWT + password | Begin voluntary enrollment. |
| `POST /me/two-factor/setup/confirm` | Final web JWT | Confirm voluntary enrollment. |
| `POST /me/two-factor/backup-codes/acknowledge` | Final web JWT | Mark recovery codes saved. |
| `POST /me/two-factor/backup-codes/regenerate` | Final web JWT + fresh factors | Replace all backup codes. |
| `DELETE /me/two-factor` | Final web JWT + fresh factors | Disable when policy permits. |
| `DELETE /admin/users/{id}/two-factor` | Recent-MFA admin web JWT | Reset target and revoke all credentials. |
| `GET /admin/security` | Admin web JWT | Read display-only policy projection and transition status. |
| `POST /admin/two-factor-enforcement/enable` | Recent-MFA admin web JWT | Start/resume the dedicated durable policy transition. |

All secret- or challenge-bearing responses carry `Cache-Control: no-store`.
OpenAPI examples use synthetic values and never include a real secret.
Route/schema changes require `pnpm check:openapi`.

## §14 Migration and compatibility

- Add User authentication fields through an RFC-0008 blocking boot migration;
  strict version-claim verification is a second deployment cutover.
- Backfill PAT and OAuth issue versions to 1.
- Add version claims to web, OAuth access, collab, presence, and notification
  tokens.
- Default `security:twoFactorRequired` to false.
- Do not create or accept a plaintext TOTP field.
- Do not auto-enroll existing Users.
- Do not preserve a claim-less JWT compatibility path after strict cutover.
- A deployment without `CROWI_ENCRYPTION_KEY` cannot enroll; after enrollment,
  key removal/rotation is prohibited until the §6.3 keyring migration exists.
- Login API and `loginWithPassword` change to a discriminated response in one
  coordinated release; Crowi 2.0 has no supported legacy direct-login native
  client.

## §15 Tests and acceptance criteria

### §15.1 Authentication boundary

- Correct password for an enrolled User returns no final token before factor
  completion.
- Pending cookies fail on every `createJwtAuth` route.
- Password reset, activation, invitation, and refresh follow §3.2.
- Production token-issuance call-site tests prevent bypassing central
  completion.
- A used or stale activation link cannot sign in an active User.
- A used or generation-stale reset link cannot change a password.
- A confirmed self-service email change invalidates an already-issued reset
  link.

### §15.2 Cookie, CSRF, and editor behavior

- Pending cookie is HttpOnly, production-Secure, host-only, short-lived, and
  absent from response JSON/localStorage/sessionStorage/URLs.
- Wrong Origin, missing Origin, missing CSRF header, and mismatched nonce are
  rejected before factor verification.
- Same-origin cookie login/verify is covered; split-origin deployment is
  explicitly unsupported.
- The public login page completes both steps in place.
- The editor modal completes password plus TOTP/backup without route change,
  Y.Doc unmount, or CodeMirror buffer loss.
- Challenge-slot exhaustion returns the modal to its password step without
  navigation.

### §15.3 Atomicity, TOTP, and recovery

- The fifth wrong code closes the challenge/account budget with Redis disabled.
- Parallel challenge slots cannot supersede another live login or reset the
  account budget.
- Concurrent invalid requests cannot exceed the atomic attempt ceiling.
- SHA-1, six digits, 30 seconds, current/previous-only behavior is fixed by
  time-controlled vectors.
- A future-step value is rejected.
- A previously accepted step is rejected on the same and another API replica.
- Enrollment confirmation code cannot immediately authenticate again.
- Ten backup codes contain at least 128 bits each, are returned once, stored
  hash-only, and consumed once.
- Concurrent TOTP or backup use yields at most one final response.
- Collection unique-index lookup, query-time expiry, parallel consume, and the
  accepted User-update/consume crash loss are tested without transactions.

### §15.4 Secret lifecycle

- Missing/malformed encryption returns 503 for setup.
- MongoDB never receives plaintext TOTP secret, `otpauth` URI, backup code, or
  cookie token.
- Secret fields are absent from normal User queries and JSON.
- Setup is not enabled before a valid first TOTP.
- Expired pending setup and challenge state is rejected at query time.

### §15.5 Revocation and Redis absence

- Every operation in §8.1 invalidates old web access and refresh JWTs.
- Refresh does not prompt but rejects stale `authVersion`.
- Self-service changes and password reset preserve PAT/OAuth credentials.
- Administrator/operator reset rejects old web JWT, PAT, OAuth access JWT, and
  OAuth refresh token immediately through User fences.
- Reset succeeds with Redis absent and closes local collab, presence, and
  notification sockets.
- Notifications and collab revalidate established `authVersion` and close on
  mismatch.
- In multi-replica mode recovery is unavailable without a completed
  cross-replica disconnect acknowledgement; the operator CLI runbook requires
  drain/restart acknowledgement before completion.

### §15.6 Policy and lockout

- Policy enablement fails without encryption readiness, recent MFA, and two
  recovery-ready active administrators.
- Existing affected sessions are unusable during and after transition.
- Unenrolled local-password Users reach forced setup, not the application and
  not permanent denial.
- Federated login is exempt.
- Policy disable preserves individual enrollment.
- Web reset cannot target self or remove the last recovery-ready peer admin.
- Concurrent resets/enforcements are serialized by the durable recovery guard.
- A failed conditional reset produces a failed operation, never a succeeded
  audit event; retries and reconciliation by operation id are idempotent.
- Operator reset recovers a sole admin and works without Redis or TOTP
  decryption.

### §15.7 Engineering gates

- Unit/integration tests cover User conditional updates, races, clock
  boundaries, key failure, Redis absence/failure, and all issuance paths.
- Web tests cover response discrimination, token non-storage, inline editor
  reauthentication, QR/manual entry, backup acknowledgment, and expiry.
- Admin tests cover recent assurance, self-target prohibition, event ordering,
  partial cleanup, and policy-transition resume.
- Type-check, lint, focused tests, OpenAPI drift checks, and affected-package
  builds pass with no new `any`.
- Each user-facing delivery phase includes an appropriate changeset.

## §16 Alternatives considered

### §16.1 Natural JWT expiry

Letting access tokens survive for an hour and refresh tokens for thirty days
after a factor or password change is incompatible with immediate revocation.
Rejected in favor of `authVersion`.

### §16.2 One version for every credential

Using `authVersion` for web JWTs, PATs, and OAuth would make routine backup-code
regeneration disconnect MCP, CLI, and automation. Rejected because
self-service assurance maintenance is not compromise recovery.

### §16.3 Row cleanup without an API credential version

Deleting PAT and OAuth refresh rows does not revoke an already-issued
stateless OAuth access JWT and creates partial-failure windows. Rejected;
`apiCredentialVersion` is the immediate authority.

### §16.4 Plaintext TOTP when encryption is unset

Config preserves legacy plaintext behavior when no key exists. Applying it to
a reusable TOTP seed would let a database leak defeat the second factor.
Rejected; enrollment and policy enablement fail closed.

### §16.5 Unversioned encryption-key rotation

The current unversioned envelope cannot support safe rotation for User secrets.
Rejected as an operational mode: key removal or rotation after enrollment is
forbidden until the §6.3 versioned-keyring migration and User re-encrypt path
are implemented.

### §16.6 Server-generated QR image

A PNG/SVG endpoint adds a secret-bearing cache and logging surface without
avoiding manual-secret delivery. Rejected in favor of browser-local rendering.

### §16.7 Applying Crowi TOTP after federated login

Stacking a local factor after an IdP login duplicates IdP policy and creates a
Crowi recovery dependency for federated-only Users. Rejected. Future providers
expose assurance metadata for step-up decisions.

### §16.8 Email/password reset disables TOTP

Treating mailbox access as sufficient to remove TOTP turns password reset into
a bypass. Rejected. Reset changes the password and revokes web sessions, then
requires the existing TOTP/backup factor or administrator/operator recovery.

### §16.9 Hidden global bypass or master recovery code

A permanent bypass becomes the installation's highest-value credential and is
difficult to rotate or audit. Rejected. Recovery is explicit, target-specific,
credential-revoking, and recorded.

## §17 Phased plan

### §17.1 Phase 1 — secure opt-in vertical slice

- prerequisite Markdown sanitization plus restrictive CSP, or dedicated
  MFA/session-origin isolation;
- User versions, activation/reset generations, two-factor state, hash-indexed
  challenge collection, and blocking migration;
- encrypted pending/active secret lifecycle;
- fixed TOTP profile and adapter;
- HttpOnly pending-cookie and CSRF protocol;
- password login, editor inline reauthentication, password reset, activation,
  invitation, and confirmed self-service email-change central completion;
- access/refresh `authVersion` checks;
- status, setup, confirm, disable, acknowledgment, and regeneration;
- ten show-once backup codes and atomic consumption;
- collection challenge/account ceilings and replay prevention, with optional
  Redis defense;
- browser-local QR/manual enrollment UX;
- minimal SecurityEvent model;
- shared all-credential reset primitive and local per-user socket disconnect
  handles;
- DB-direct operator break-glass command;
- encryption/NTP/operator documentation; and
- OpenAPI, tests, and changesets.

Phase 1 does not include global enforcement, but it does not ship without
operator recovery.

### §17.2 Phase 2 — administrator recovery and assurance

- Administrator TOTP status and reset API/UI.
- Recent-MFA step-up for reset, PAT issuance, and selected sensitive settings.
- Administrator/operator reset history and inspection surface.
- Reset and backup-code-use notifications.
- Recovery-ready administrator status and warnings.
- Partial-cleanup repair and operational hardening.

Phase 2 lands before global enforcement.

### §17.3 Phase 3 — global local-password enforcement

- display-only `security:twoFactorRequired` projection plus dedicated,
  Mongo-authoritative enforcement transition API/UI.
- Fail-closed resumable enforcement transition.
- Forced-enrollment endpoints and web interstitial.
- Activation, invitation, and password-reset forced setup.
- Two-admin recovery-readiness preconditions.
- Self-disable and last-recovery-admin guards.
- Policy security events and operator documentation.

### §17.4 Future factors and clients

- Add RFC-0014 provider `amr`/`acr` assurance.
- Add WebAuthn/passkeys while reusing the final-token boundary.
- Add a separately reviewed pending transport only if a native client needs
  direct password login.
- Consider purpose-derived encryption keys with a versioned keyring.
- Add role/group enforcement or grace periods only in a separate design.

## §18 Open questions

No blocking authentication-boundary, transport, persistence, editor, or
Redis-dependency questions remain. These implementation-scoped choices must be
closed in their phase specifications without weakening this RFC:

1. **Pinned TOTP and QR packages.** `otplib` and `qrcode` are candidates; exact
   versions must pass the dependency, license, asymmetric-window,
   constant-time, module-format, and bundle-size review in §12.6.
2. **Trusted-proxy address configuration.** Crowi has no shared trusted-client
   IP resolver. Phase 1 must define proxy configuration and direct-peer
   fallback before an auxiliary IP bucket trusts forwarded headers. Embedded
   challenge/account limits do not depend on this choice.
3. **SecurityEvent retention and inspection.** Reset and policy events are
   durable and append-only from their first phase. Retention and whether
   Phase 2 exposes an admin UI, an operator-CLI query, or both remain to be
   selected.

## §19 References

- [RFC 6238 — TOTP: Time-Based One-Time Password Algorithm](https://www.rfc-editor.org/rfc/rfc6238.html)
- [Google Authenticator Key URI Format](https://github.com/google/google-authenticator/wiki/Key-Uri-Format)
- [OWASP Multifactor Authentication Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Multifactor_Authentication_Cheat_Sheet.html)
- [OWASP Cryptographic Storage Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Cryptographic_Storage_Cheat_Sheet.html)
- [NIST SP 800-63B — Authenticators](https://pages.nist.gov/800-63-4/sp800-63b/authenticators/)
- `packages/api/src/hono/handlers/token-auth.ts`
- `packages/api/src/hono/handlers/password-reset.ts`
- `packages/api/src/hono/handlers/activation.ts`
- `packages/api/src/hono/handlers/invite-accept.ts`
- `packages/api/src/hono/handlers/access-token.ts`
- `packages/api/src/hono/handlers/oauth.ts`
- `packages/api/src/hono/middleware/auth.ts`
- `packages/api/src/hono/middleware/cors.ts`
- `packages/api/src/hono/handlers/admin/users.ts`
- `packages/api/src/hono/handlers/admin/security.ts`
- `packages/api/src/models/user.ts`
- `packages/api/src/models/personal-access-token.ts`
- `packages/api/src/util/crypto.ts`
- `packages/api/src/util/jwt.ts`
- `packages/api/src/util/ws-token.ts`
- `packages/api/src/util/presence-token.ts`
- `packages/api/src/util/notifications-token.ts`
- `packages/api/src/util/mail-token.ts`
- `packages/api/src/util/rate-limit.ts`
- `packages/api/src/mcp/attach.ts`
- `packages/api/src/collab/attach.ts`
- `packages/api/src/presence/attach.ts`
- `packages/api/src/notifications/attach.ts`
- `packages/cli/src/lib/oauth.ts`
- `packages/admin-cli/src/cli.ts`
- `packages/web/src/lib/auth-token.ts`
- `packages/web/src/lib/api-client.ts`
- `packages/web/src/lib/auth-login.ts`
- `packages/web/src/lib/session-reauth-context.tsx`
- `packages/web/src/components/editor/session-reauth-modal.tsx`
- `packages/web/next.config.ts`
- `packages/api-contract/src/schemas/admin/security.ts`
- `docs/rfcs/0006-hono-integration.md`
- `docs/rfcs/0008-migration-framework.md`
- `docs/rfcs/0010-oauth-and-api-access.md`
- `docs/rfcs/0011-crowi-mcp.md`
- `docs/rfcs/0012-crowi-cli.md`
- `docs/rfcs/0014-auth-provider-plugins.md`
