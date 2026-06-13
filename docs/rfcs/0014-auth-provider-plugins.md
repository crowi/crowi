# RFC-0014: Auth Provider Plugins (federated sign-in via vendor plugins)

- **Status**: Draft
- **Author**: (you)
- **Created**: 2026-06-08
- **Depends on**:
  - RFC-0001 (Plugin Architecture) Step 10 — `registerAuth` registry,
    `AuthDriver` / `AuthProfile` / `AuthVerifyResult`, `configSchema` +
    `@sensitive`, `adminPlacement: { section: 'auth' }`, `reconfigure`,
    transitive `requires` load, `PluginContext.crypto`. This RFC defines
    *how the collected drivers are actually used*, which RFC-0001 left as
    "a later step".
  - RFC-0006 (Hono Integration) — the app the auth flow mounts onto;
    `createJwtAuth`, the public-route precedent (`/oauth/*`).
  - RFC-0010 (OAuth 2.0 Foundation) — Crowi as an OAuth **provider**
    (*outbound*). This RFC is the **inbound** axis (Crowi as an OAuth
    *client* of Google/GitHub/OIDC IdPs). They share the JWT issuance
    primitives (`util/jwt.ts`, refresh-token model) but are otherwise
    orthogonal — see §2.
- **Related**:
  - RFC-0013 (Slack Plugin) — establishes the **vendor-integrated plugin**
    pattern (one plugin owns one vendor App, contributes to several
    registries) and implements the general `registerRoutes` on Hono.
    This RFC adopts the same vendor-plugin philosophy and **coordinates**
    on `registerRoutes` (§6): auth flow does *not* ride on it.

## §0 Summary

Bring **federated sign-in** (Google / GitHub today, OIDC / SAML / LDAP later)
into Crowi as **vendor plugins**, and define the runtime that turns a
registered `AuthDriver` into a working "Sign in with X" button.

The design rests on three decisions:

1. **Drivers are typed by *flow shape*, not by vendor** — a discriminated
   union of `kind: 'credential' | 'oauth2' | 'oidc'` (with `'saml'` reserved).
   `credential` covers LDAP / local password (user hands credentials to
   Crowi); the rest are redirect/federated (browser bounces to an external
   IdP and returns via a callback).
2. **Core owns the flow skeleton; plugins own protocol mapping.** The
   federated callback route, OAuth state (signed cookie + PKCE), and the
   "`AuthProfile` → resolve/provision User → issue JWT" bridge are
   implemented **once in core**, parameterised by provider name. Plugins
   never hand-roll OAuth security. Reusable protocol logic ships as **core
   SDK driver factories** (`createOidcDriver`, `createOAuth2Driver`) that any
   plugin composes.
3. **Plugins are vendor-axis** (`@crowi/plugin-google`, `@crowi/plugin-github`)
   — each owns one vendor's OAuth App and may contribute *more than auth*
   over time (Google Drive embed/attachment, GitHub repo embed). A separate
   **protocol-axis** `@crowi/plugin-auth-oidc` covers "bring-your-own IdP"
   enterprise SSO (Okta / Azure AD / Keycloak) by config alone.

The legacy Express session + Passport OAuth has **already been removed**
(RFC-0006); there is no Google/GitHub sign-in in the product right now. So
this is **new construction**, not a migration. The motivating "remove
express-session / passport / connect-redis" goal from the original spec is
already done.

## §1 Motivation

- Today the only sign-in is email + password (`hono/handlers/tokenAuth.ts`).
  Google / GitHub login existed in the legacy Express layer and was deleted
  wholesale with it; the `google:clientId` / `github:clientId` config rows
  and `User.googleId` / `User.githubId` columns are the only remnants.
- We want to re-introduce social sign-in **as plugins**, so:
  - operators add a provider without rebuilding the app;
  - enterprise SSO (OIDC / SAML / LDAP) can be added later as *more drivers*,
    not core surgery;
  - a vendor's non-auth capabilities (Google Drive, GitHub repos) have a
    natural home next to its auth.
- The plugin SDK already collects `AuthDriver`s (`plugin-manager.ts` calls
  `plugin.registerAuth`) but **nothing consumes them** — there is no login
  button endpoint, no callback runtime, no JWT-from-profile bridge. This RFC
  builds that consumer.

## §2 Two OAuth axes — do not conflate

Crowi has OAuth on **both sides**, and they are independent:

| | RFC-0010 (provider) | RFC-0014 (this, client) |
|---|---|---|
| Crowi's role | OAuth **authorization server** | OAuth **client / relying party** |
| Direction | *outbound* — CLI/MCP act "as a user" | *inbound* — a user signs in via Google |
| Routes | `/oauth/authorize`, `/oauth/token`, … | `/api/v2/auth/providers/<name>/{start,callback}` |
| Existing? | Implemented (`hono/handlers/oauth.ts`) | Not implemented |

They share only the **JWT issuance primitives** (`util/jwt.ts`
access/refresh, the refresh-token model). The federated bridge in §5 issues
the *same* session JWT that `tokenAuth.ts` issues for email/password, so the
web client (`crowi.accessToken` cookie, `use-auth.ts`) is unchanged.

## §3 Driver model — kinds, not vendors

The current SDK has a single `AuthDriver.verify(unknown)`. That is exactly
right for **credential** auth (LDAP / local) but insufficient for
**federated** auth, which additionally needs redirect-URL construction, state,
and code exchange. Rather than overload `verify`, we type drivers by flow
shape:

```ts
// @crowi/plugin-api — registries/auth.ts (extended)

export interface AuthProfile {            // unchanged from today
  providerUserId: string;                 // stable id in provider namespace
  email?: string; name?: string; imageUrl?: string;
  extra?: Record<string, unknown>;
}

/** Direct-credential auth: user submits credentials to Crowi. (LDAP, local) */
export interface CredentialAuthDriver {
  kind: 'credential';
  buttonLabel?: string;                   // usually none — rendered as the form
  /** Fields to render on the sign-in form (e.g. [username, password]). */
  fields: CredentialField[];
  verify(credentials: Record<string, string>): Promise<AuthVerifyResult>;
}

/** Client credentials, read lazily at request time — see §4. */
export interface OAuthClientConfig {
  clientId: string; clientSecret: string;
}

/** Redirect/federated auth: browser bounces to an external IdP. */
export interface OAuth2AuthDriver {
  kind: 'oauth2';
  buttonLabel: string; iconUrl?: string;
  authorizeUrl: string; tokenUrl: string;
  scopes: string[];
  pkce?: boolean;                         // declare when the IdP supports S256 (§5)
  /**
   * Lazy accessor, evaluated per request — NOT captured at registration.
   * Returns null while the plugin is unconfigured; core then hides the
   * provider from `GET /providers` (enablement) and rejects /start.
   * Lazy evaluation is also what makes admin config changes
   * (`reconfigure`) take effect without re-registering the driver.
   */
  getClientConfig(): OAuthClientConfig | null;
  /**
   * Exchange completed; fetch the provider profile and map it.
   * Returns AuthVerifyResult so the driver can REJECT after a successful
   * exchange — e.g. the GitHub members-of-org gate (§8): authentication
   * succeeded but policy says no. Failures land on the §5.2 error path.
   */
  fetchProfile(tokens: OAuthTokens): Promise<AuthVerifyResult>;
}

/** OIDC = OAuth2 + standardised discovery + id_token claims. */
export interface OidcAuthDriver {
  kind: 'oidc';
  buttonLabel: string; iconUrl?: string;
  discoveryUrl: string;                   // …/.well-known/openid-configuration
  scopes: string[];                       // default ['openid','email','profile']
  getClientConfig(): OAuthClientConfig | null;  // same lazy contract as oauth2
  /**
   * Optional policy gate, called after core validates the id_token and
   * before mapClaims — the oidc analogue of fetchProfile's rejection
   * (e.g. Google Workspace `hd` domain restriction).
   */
  authorize?(claims: Record<string, unknown>): Promise<{ ok: true } | { ok: false; reason: string }>;
  /** Optional claim → AuthProfile override; default maps sub/email/name. */
  mapClaims?(claims: Record<string, unknown>): Partial<AuthProfile>;
}

// 'saml' is reserved (§9) — added without touching the above.
export type AuthDriver =
  | CredentialAuthDriver | OAuth2AuthDriver | OidcAuthDriver;
```

**Why a discriminated union and not "OAuth-only" (spec option 4-a) or
"generic verify" (4-b):** SSO/LDAP forces *both* shapes. `verify`-only makes
every OAuth plugin re-implement state/PKCE/callback (3 plugins → 3
divergent, security-sensitive implementations). OAuth-only cannot express
LDAP at all. Kinds give core a stable seam to own the shared machinery
per shape, while keeping LDAP's genuinely-simple `verify` simple.

### §3.1 Driver names (slugs) — decided

The registered driver name is the `<name>` in
`/api/v2/auth/providers/<name>/callback`, i.e. **part of the URL the operator
registers in the IdP's console** — it must be short, URL-safe, and stable:

- Charset `^[a-z0-9][a-z0-9-]*$` (no `@`, `/`, `:` — never the npm package
  name).
- **Vendor plugins declare a fixed slug**: `google`, `github`.
- **Protocol plugins (generic `plugin-auth-oidc`) take the slug from operator
  config** (e.g. `okta`, `keycloak-prod`) — the same plugin can serve several
  IdP instances, so the name cannot be hardcoded. The admin UI warns that
  changing the slug invalidates the callback URL registered at the IdP.
- The registry rejects duplicate names at registration time.

## §4 Driver factories (reusable protocol logic in the SDK)

Protocol logic is shipped as **core SDK factories**, *not* as plugins, so a
vendor plugin and the generic OIDC plugin share one implementation:

```ts
// inside a plugin's registerAuth(registry, ctx):
registry.register('google', createOidcDriver({
  discoveryUrl: 'https://accounts.google.com/.well-known/openid-configuration',
  scopes: ['openid', 'email', 'profile'],
  buttonLabel: 'Google',
  // lazy — evaluated per request, never captured at registration:
  getClientConfig: () => {
    const cfg = ctx.config<GoogleConfig>();
    return cfg.clientId && cfg.clientSecret
      ? { clientId: cfg.clientId, clientSecret: cfg.clientSecret }
      : null;
  },
}));
```

`createOidcDriver` / `createOAuth2Driver` return a fully-formed driver object
(no I/O at registration; discovery is fetched lazily/cached at first use).
This is the layering that reconciles "implement Google as OIDC" with "bundle
Google as a vendor plugin": the *logic* is shared library code; the *plugin*
is the vendor wrapper that owns credentials and branding.

**Config is read lazily, never baked in at registration.** Registration
happens once at boot, but plugin config changes at runtime: the admin UI save
and the Redis pub/sub remote-change path both fan out `reconfigure`
(`plugin-manager.ts` already implements this). A driver holding credentials
captured at boot would go stale, and re-registering on `reconfigure` would
trip the duplicate-name rejection (§13). The lazy `getClientConfig()` contract
dissolves both problems — `reconfigure` needs no auth-specific handling at
all — and doubles as the **enablement signal**: `null` (plugin installed but
not yet configured) hides the provider from `GET /providers` and 404s
`/start`, replacing the legacy `googleLoginEnabled(config)` check. No broken
"Sign in with X" button for a half-configured plugin.

## §5 Core-owned flow skeleton

Core mounts **one** parameterised route family (public; not `registerRoutes`):

```
GET  /api/v2/auth/providers                      → list enabled drivers for login UI
GET  /api/v2/auth/providers/:name/start          → 302 to IdP
GET  /api/v2/auth/providers/:name/callback       → IdP redirect target
POST /api/v2/auth/handoff                        → one-time code → token pair (§5.3)
POST /api/v2/auth/providers/:name/verify         → credential-kind submit  [DEFERRED]
```

> **`/verify` and credential-kind form rendering are deferred** (see §3 /
> §10): v1 ships no `credential` driver (LDAP is deferred, local
> email/password stays on the existing `tokenAuth.ts` path). The `credential`
> *type* is in the union for forward-compat, but its *runtime* (`/verify`
> route + dynamic field rendering) is built together with the first credential
> driver — symmetric with how `saml` is handled (§9). The routes that ship in
> v1 are `providers` / `start` / `callback`.

The skeleton is intentionally written around an **abstract middle** so SAML
slots in later (§9):

```
start  → build redirect to IdP + persist state         (driver kind decides how)
       ← external IdP authenticates the user
callback → recover state → obtain AuthProfile           (driver kind decides how)
         → resolveOrProvisionUser(profile)              (core, common)
         → mint one-time handoff code                   (core, common — §5.3)
         → redirect to web /login/complete?code=…&continue=<validated>
web JS   → POST /api/v2/auth/handoff { code }
         ← { user, accessToken, refreshToken, expiresIn }   (same shape as /auth/login)
         → storeTokens(...) → navigate to continue url
```

- **oauth2**: `start` builds `authorizeUrl?...&state=…` (+ `code_challenge`
  when the driver declares `pkce: true`, see below); `callback` validates
  `state`, runs the code exchange, calls `driver.fetchProfile` — which may
  **reject** (policy gates like the GitHub org check) even after a successful
  exchange; rejections take the §5.2 error path.
- **oidc**: as oauth2, plus the request carries a separate `nonce` echoed into
  the `id_token`. `callback` **validates the `id_token` as a core
  responsibility**: fetch + cache the IdP JWKS (from the discovery document),
  verify signature + `iss` / `aud` / `exp` and that the `nonce` claim matches
  the issued nonce, then run the driver's optional `authorize(claims)` policy
  gate, then apply `mapClaims`.
- **credential** *(deferred)*: no redirect; form POSTs to `…/verify`, core
  calls `driver.verify(credentials)`. Returns the token pair directly as JSON
  (like `/auth/login`) — no handoff hop needed since there is no cross-origin
  redirect.

**PKCE is driver-declared, `state` is always required.** The skeleton always
issues + validates `state` (CSRF). PKCE (S256) is layered on when a driver
opts in (`pkce: true`) — not all OAuth2 IdPs accept a `code_challenge`, so it
is not hardcoded as mandatory for the `oauth2` kind. `oidc` defaults PKCE on
(broadly supported); `oauth2` declares per provider.

### §5.1 OAuth state — signed cookie

State lives in a **signed, HttpOnly cookie** (spec option A), not session
(removed) and not Mongo:

```
Set-Cookie: crowi.oauth_state=<HMAC-signed>;
  HttpOnly; SameSite=Lax; Secure(prod); Path=/api/v2/auth/providers; Max-Age=300
payload = {
  state,              // CSRF token — matched against the `state` query param on callback
  oidcNonce?,         // oidc only — echoed into id_token; replay protection (§5, B-2)
  codeVerifier?,      // present only when the driver declares PKCE
  provider,
  continueUrl,        // post-login redirect — MUST be validated (see below)
  linkToUserId?,      // reserved for explicit account linking (§11)
}
```

Stateless, no extra infra, survives multi-instance without sticky sessions.

**Security requirements on the state machinery:**

- **`state` vs `oidcNonce` are distinct values with distinct jobs** (B-2):
  `state` defends the callback against CSRF (matched to the query param);
  `oidcNonce` (oidc only) is echoed into the `id_token` and prevents token
  replay. The `oauth2` kind has no `id_token`, so it carries `state` only.
- **`continueUrl` open-redirect guard** (B-1): on callback the redirect target
  **MUST be a local relative path** (reject any value with a scheme / `//`
  authority / external origin), falling back to the app root. Federated
  post-login redirect is a classic phishing vector.
- **Cookie signing key is HKDF-derived, not the raw JWT secret** (B-3): derive
  a labelled subkey, e.g. `HKDF(jwtSecret, info="oauth-state-hmac")`, so the
  state HMAC and the session-JWT signature never share a raw key (clean key
  rotation, no cross-purpose reuse). *Caveat:* the JWT secret source itself
  still has a weak dev fallback (`'your-secret-key'`); hardening that is
  existing posture, out of scope for this RFC.
- **One-time consumption**: the callback **clears the state cookie
  unconditionally** (success or failure) once it has read it. The IdP code is
  single-use anyway, so this is hygiene, not the primary defence — but it
  keeps a captured callback URL from being replayed within the 5-minute TTL.
- **Concurrent-tab note** (open point §13): a single `crowi.oauth_state` cookie
  means two OAuth flows started in parallel tabs collide (the second overwrites
  the first, failing the first's callback). Acceptable for v1; a per-provider
  cookie name or a short bounded list is the fix if it bites.

Provider refresh tokens are *not* part of the state cookie — when a vendor
capability requests offline access they are persisted encrypted on
`UserIdentity` under the policy in §7 ("Provider refresh tokens").

### §5.2 JWT issuance bridge

`resolveOrProvisionUser` + issuance is **core-internal** (spec problem 6,
option 3): the skeleton calls the same internal JWT util `tokenAuth.ts` uses.
Plugins never touch JWT — they only ever produce an `AuthProfile`. No
`_internal/issue-from-profile` HTTP endpoint is exposed.

User resolution / JIT provisioning (shared by all kinds) honours
`security:registrationMode` (Open / Restricted / Closed) and the
allowlist, exactly as legacy did — provisioning a brand-new user from a
federated profile is a "registration".

**Failure path (C-3):** when a federated user authenticates *successfully* at
the IdP but is then rejected by registration policy (Closed, or Restricted +
not on the allowlist) or a driver policy gate (`fetchProfile` rejection /
`authorize`), the callback **MUST redirect to the login page with an error
code** (e.g. `?error=registration_closed`), not throw a 500. Same treatment
for any post-IdP resolution failure (suspended user, etc.). The login page
renders a human-readable message per error code.

### §5.3 Token handoff to the web client (one-time code)

The callback is a top-level navigation on the **api** origin, but the web
client's session lives in **localStorage** (`auth-token.ts`: access + refresh
in localStorage; the `crowi.accessToken` cookie is a non-HttpOnly *mirror
written by JS* for `<img>` requests, and `api-client.ts`'s 401-refresh
interceptor reads `localStorage.refreshToken`). A server-set cookie therefore
**cannot** establish a session the existing client recognises, and the refresh
token would never reach it.

So the callback ends with a **one-time handoff code**, not tokens:

- Callback mints a random, single-use code (TTL ~30 s) bound to the resolved
  user, stores `hash(code) → userId` (Redis when available, in-memory map
  otherwise — same posture as other ephemerals; the code is consumed on the
  next request, so single-instance dev without Redis is fine), then 302s to
  the web app: `/login/complete?code=<code>&continue=<validated path>`.
- The `/login/complete` page POSTs `{ code }` to `POST /api/v2/auth/handoff`,
  which consumes the code and responds with the **exact `/auth/login` response
  shape** (`{ user, accessToken, refreshToken, expiresIn }`). The page calls
  the existing `storeTokens()` and navigates to `continue`.
- Properties: tokens never appear in a URL / browser history / proxy log; the
  code is single-use and useless after 30 s; the existing token-storage and
  refresh machinery is reused unchanged. Works in dev (web :4302 / api :4301)
  because the handoff is a fetch, not a cookie.

## §6 Relationship to `registerRoutes` (RFC-0013)

RFC-0013 implements the general `registerRoutes` on Hono (Slack needs inbound
webhook routes). **Auth flow deliberately does not use it.** Reasons:

- Auth security (state, PKCE, JWT issuance, registration-mode gating) must be
  uniform and core-owned; letting each plugin define raw routes invites
  divergent, unsafe implementations.
- A vendor plugin may use *both*: its **auth** contribution goes through
  `registerAuth` + the core skeleton; its **non-auth** routes (e.g. a Google
  Drive webhook) go through `registerRoutes`.

So this RFC has no hard dependency on RFC-0013 landing first.

## §7 User identities — flat columns → `UserIdentity` collection

With arbitrary providers (`google`, `github`, later `okta`, `ldap`,
`onelogin`, …), the flat `googleId` / `githubId` columns no longer scale.
Identities live in a **separate collection**, not an embedded array on User:

```ts
// new collection: user_identities — one document per linked identity
UserIdentity {
  userId: ObjectId;          // ref User
  provider: string;          // driver slug: 'google', 'github', 'okta'
  providerUserId: string;    // == AuthProfile.providerUserId
  linkedAt: Date;
  /**
   * Provider-issued refresh token, encrypted at rest (`enc:v1:` via
   * ctx.crypto / CROWI_ENCRYPTION_KEY). Present only when a vendor
   * capability requested offline access — see "Provider refresh
   * tokens" below.
   */
  providerRefreshTokenEnc?: string;
}
// indexes:
//   { provider: 1, providerUserId: 1 }  unique   ← the login lookup
//   { userId: 1 }                                ← "list my linked accounts"
```

**Provider refresh tokens (decided):** the schema carries the field from day
one, governed by three rules:

1. **Sign-in never requests offline access.** The login flow keeps minimal
   scopes (`openid email profile`); Google only returns a `refresh_token`
   with `access_type=offline` (+ `prompt=consent`), which a pure sign-in
   doesn't ask for. Offline access is requested later, with explicit user
   consent, by the vendor capability that needs it (e.g. plugin-google's
   future Drive integration) — clicking "Sign in with Google" must not ask
   for Drive-grade power. (GitHub classic OAuth tokens don't expire and have
   no refresh token unless token-expiration is opted in; same rule applies.)
2. **Encryption is a hard requirement for persistence.** A provider token
   leak reaches *outside* Crowi (the user's Google data), so unlike Sensitive
   Config there is **no plaintext fallback**: if `isEncryptionConfigured()`
   is false, the token is not persisted and a warning is logged. Stored via
   `ctx.crypto.encrypt` (`enc:v1:` prefix, AES-256-GCM).
3. **Never key queries on the ciphertext** — `encrypt` is non-deterministic;
   lookups go through `(provider, providerUserId)` / `userId` only.

**Why a separate collection (not `User.identities[]`):**

- **Postgres portability** (project stance): this is exactly a join table —
  it ports as-is. An embedded array would have to be decomposed later anyway.
- **Uniqueness is trivial**: a plain compound unique index on
  `(provider, providerUserId)` — no multikey-index semantics on array
  subdocuments to reason about (unique multikey indexes don't dedupe within a
  document, and compound bounds on array elements need `$elemMatch`).
- **Link / unlink are insert / delete** — no positional array updates.

Resolution at login is two cheap reads: `UserIdentity.findOne({provider,
providerUserId})` → `User.findById(userId)`.

**Migration (v1-compatible, included in this RFC):**

- Boot-time idempotent backfill: each `User` with `googleId` gets a
  `UserIdentity { provider: 'google', providerUserId: googleId }` upsert, same
  for `githubId`. Also exposed as `crowi-admin migrate auth-identities`.
- **No transition-window dual read.** The backfill is idempotent and runs at
  boot before traffic, so runtime lookups read `UserIdentity` only — no
  "identities OR legacy column" query path (per project policy: no fallback /
  compat layers by default). The legacy `googleId` / `githubId` columns are
  kept on the document for rollback safety but are **never read** by v2 code.

## §8 Config namespace

Auth config moves from core (`google:clientId`, …) into each plugin's
namespace (`plugin:@crowi/plugin-google:clientId`, …), auto-rendered by the
schema-driven admin form under the **`auth` sidebar section**
(`adminPlacement: { section: 'auth' }`, already recognised). `clientSecret`
carries the `@sensitive` marker (auto-encrypt). The static
`config-sensitive.ts` entries (`crowi:google:clientSecret` etc.) are removed
once the plugin owns them (plugins register `@sensitive` keys at boot).

`github:organization` (members-of-org gate) becomes a plugin config field.

## §9 SAML extensibility (forward-compat only; full design = separate RFC)

SAML is **out of scope** but must not force a later redesign (per the design
agreement). The seams that guarantee that:

- The driver union is open: add `kind: 'saml'` with `idpMetadata` +
  `parseResponse(samlResponse) → AuthProfile`. No change to existing kinds.
- The flow skeleton's "abstract middle" (§5) is not hardcoded to OAuth's
  code/token exchange — SAML adds an **ACS** callback variant
  (`POST …/callback`, RelayState carries the state nonce) reusing the same
  `resolveOrProvisionUser` + issuance.
- `UserIdentity` already keys on `(provider, providerUserId)`, so a SAML
  NameID is just another `providerUserId`.

LDAP is likewise deferred: `kind: 'credential'` exists *now* so its login-form
seam and `verify` path are designed in, but no LDAP plugin is built here.

## §10 Web login page

`(public)/login` currently renders email+password only. In v1 it will:

- `GET /api/v2/auth/providers` → render one `Sign in with X` button per
  **enabled** `oauth2`/`oidc` driver (unconfigured drivers are filtered out
  server-side, §4). Email/password remains as the built-in local path
  (existing `tokenAuth.ts`), hidden when `security:disablePasswordAuth` is set.
- Buttons link to `…/providers/<name>/start?continue=<url>`.
- New `(public)/login/complete` page: receives the one-time handoff code,
  exchanges it via `POST /api/v2/auth/handoff`, stores tokens with the
  existing `storeTokens()`, and navigates to `continue` (§5.3).

**Deferred (A-1):** rendering arbitrary `credential` drivers as their declared
`fields` ships with the first credential driver (LDAP), together with the
`/verify` route (§5). v1 has no `credential` driver beyond built-in local, so
no dynamic field rendering is built yet.

## §11 Non-goals

- **SAML / LDAP implementation** — forward-compat seams only (§9).
- **MFA / TOTP**, **external user pools (Cognito)** — separate future work.
- **Account linking UX** (attach Google to an existing logged-in user) —
  *deferred to a follow-up*. The state cookie already reserves `linkToUserId`
  (§5.1) so the `/providers/:name/start` route can later accept a `link=1`
  param under `jwtAuth`; no schema rework needed.
- **Implicit / email-match auto-linking is NOT done in v1** (A-2). When a
  federated profile's email matches an existing **local** account, the callback
  does **not** silently attach the identity to that account — doing so at
  provision time, for an *unauthenticated* visitor, is the most dangerous form
  of linking (an account-takeover path that trusts the IdP's email). Instead
  the callback redirects to the login page with a "this email already has an
  account — sign in, then link it" message. All linking is explicit, via the
  authenticated `linkToUserId` path above. This supersedes the earlier §13
  "lean" toward `email_verified`-based auto-link.
- **Crowi-as-provider** changes — that is RFC-0010 (§2).

## §12 Phasing

1. **SDK**: extend `AuthDriver` to the kind union; add `createOidcDriver` /
   `createOAuth2Driver` factories. (No `registerRoutes` work.)
2. **`UserIdentity` collection** + boot backfill + `crowi-admin migrate
   auth-identities`. **Ordered before the skeleton** (C-2): step 3's
   `resolveOrProvisionUser` resolves users by `(provider, providerUserId)` —
   the `UserIdentity` lookup — so the model must land first (or be merged
   into step 3).
3. **Core flow skeleton**: `providers` / `start` / `callback` / `handoff`
   routes, signed HKDF-keyed state cookie (`state` + oidc `nonce`, one-time
   consumption), declarable PKCE, id_token validation (oidc), driver policy
   gates (`fetchProfile` rejection / `authorize`), enablement filtering via
   `getClientConfig()`, `resolveOrProvisionUser` (no auto-link,
   registration-mode gated, error-redirect failure path), one-time handoff
   code issuance (§5.3), JWT bridge. Wire `registerAuth` collected drivers
   into the `providers` list (the "later step" in `plugin-manager.ts`).
4. **`@crowi/plugin-google`** (OIDC factory) — the reference vendor plugin;
   proves the oidc path end-to-end.
5. **`@crowi/plugin-github`** (OAuth2 factory) — proves the non-OIDC oauth2
   path with the *same* skeleton, incl. the org-gate as a `fetchProfile`
   rejection.
6. **Web** login: dynamic provider buttons + `/login/complete` handoff page.
7. **Config migration**: move `google:*`/`github:*` into plugin namespaces;
   drop the static `config-sensitive` entries.

(`credential` `/verify` runtime, the `@crowi/plugin-auth-oidc` generic BYO-IdP
plugin, and account-linking are fast-follows once 1–6 land.)

## §13 Open points

*None remaining — all resolved below.*

**Resolved (2026-06-13, design session):**

- **Driver name slug** → vendor plugins use fixed slugs (`google`, `github`);
  generic protocol plugins take the slug from operator config. Formalised in
  §3.1.
- **Provider refresh tokens** → schema carries
  `UserIdentity.providerRefreshTokenEnc` from day one; sign-in never requests
  offline access; encryption is a hard requirement to persist (no plaintext
  fallback). Formalised in §7.
- **Concurrent-tab state collision** → **accepted for v1**: two sign-in flows
  started in parallel tabs within the 5-minute window make the
  first-started one fail its callback with a retryable error — no session
  damage, no takeover. Fix (per-provider cookie names) only if reported.

**Resolved by review (no longer open):**

- **Email-match auto-linking** → **decided: never auto-link in v1** (§11, A-2).
  The earlier lean toward `email_verified`-based auto-link is dropped; all
  linking is explicit via the authenticated `linkToUserId` path.

**Resolved by re-evaluation (2026-06-13):**

- **Stale credentials / reconfigure / enablement** → drivers read config
  lazily via `getClientConfig()` (§4); no re-registration, no auth-specific
  `reconfigure` handling, unconfigured providers hidden from the login page.
- **Driver policy rejection** → `fetchProfile` returns `AuthVerifyResult`;
  oidc gains optional `authorize(claims)` (§3) — expresses the GitHub org gate
  and Google Workspace domain restriction.
- **Web session handoff** → one-time handoff code + `POST /auth/handoff`
  (§5.3); the callback never tries to establish the localStorage-based client
  session via cookies.
- **Identity storage** → separate `UserIdentity` collection, not an embedded
  `User.identities[]` array (§7): Postgres-portable join-table shape, plain
  compound unique index, no dual-read transition window.
