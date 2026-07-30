# RFC-0010: OAuth 2.0 Foundation & Scoped API Access

- **Status**: Implemented (Phases 1–4 landed; Phase 5 future)
- **Author**: (you)
- **Created**: 2026-05-29
- **Depends on**: RFC-0006 (Hono Integration) — JWT auth, `createJwtAuth`
- **Related**: RFC-0001 (Plugin Architecture) Step 10 — the auth-provider
  plugin work (Google / GitHub OAuth) is about *inbound* auth. This RFC is
  about Crowi becoming an OAuth **provider** itself (*outbound*), a separate
  axis.

## Summary

Make Crowi itself an OAuth 2.0 authorization server so that external clients
such as the Crowi CLI / SDK can call the API "as a user" with scoped tokens.

Three acquisition paths are provided:

1. **Authorization Code + PKCE** — the standard for CLI / native apps.
   Browser consent → loopback callback for the code → token exchange.
2. **Device Authorization Grant** — for headless / CI / remote-shell
   environments that cannot open a browser. The CLI shows a `user_code` + URL
   and the user approves on another device.
3. **Personal Access Token (PAT)** — issued manually from the web UI with a
   scope + expiry. A simple path for scripts, and the **direct successor to
   the legacy `apiToken`**.

The access token is a stateless JWT carrying the scopes as a claim; the
refresh token is stored in the DB so it can be revoked and rotated. The
existing web-session JWT continues to coexist, treated as holding "all
scopes".

The legacy `apiToken` (no scope, no expiry, SHA-256) is **fully removed** by
this RFC. No fallback is kept.

## Motivation

- Today the only way for a user to drive the API externally is
  `User.apiToken`. It has no scope and no expiry, so a leak grants full,
  perpetual access — dangerous.
- We want "log in → obtain a token → act as the user" for the CLI/SDK in a
  least-privilege, revocable form.
- Page editing in the web UI goes through collab (RFC-0003), but external
  clients need to push Markdown over REST without collab. The existing
  `PUT /pages` already satisfies this; this RFC only layers scope on top.

## Design decisions (settled)

| Topic | Decision |
|---|---|
| Flows | Auth Code + PKCE / Device Flow / PAT — three paths |
| Access token | Scope-bearing JWT (stateless), extending `jwt.ts` |
| Refresh token | DB-stored, hashed, rotatable, revocable |
| Scope granularity | Per-resource read/write + umbrella `read` / `write` |
| Clients | v1 is first-party fixed client only. But `OAuthClient` is modelled from the start so admin registration of arbitrary apps (confidential clients) can be added later |
| Admin API | Out of scope for OAuth in v1 (web session only). `admin:*` scopes are reserved but not issuable |

## Scope catalog

Resource category × `read` / `write`. `write` implies the same resource's
`read` (like GitHub's repo write→read). The umbrella `read` implies every
`*:read`; `write` implies every `*:write` (and therefore every read).

| scope | handlers covered |
|---|---|
| `pages:read` / `pages:write` | page, revision, draft, backlink, search, autocomplete |
| `comments:read` / `comments:write` | comment |
| `bookmarks:read` / `bookmarks:write` | bookmark |
| `attachments:read` / `attachments:write` | attachment |
| `notifications:read` / `notifications:write` | notification |
| `profile:read` / `profile:write` | me, user |
| (reserved) `admin:read` / `admin:write` | admin/* — not issuable in v1 |

The canonical scope list lives in a single place, the `SCOPES` constant in
`packages/api-contract/src/schemas/oauth.ts`, shared by the API, web, and
the consent screen.

### Implication rule (scope satisfaction)

A required scope `R` is satisfied by a token's scope set `S` when:

- `R ∈ S`, or
- `R = "x:read"` and `"x:write" ∈ S`, or
- `R = "x:read"` and (`"read" ∈ S` or `"write" ∈ S`), or
- `R = "x:write"` and `"write" ∈ S`

## Token model & middleware

### Access token (JWT extension)

OAuth fields are added to the `util/jwt.ts` payload:

```
{
  userId, email,
  type: 'oauth_access',          // existing web sessions stay 'access'
  scope: 'pages:read pages:write', // space-delimited (RFC 6749)
  client_id: 'crowi-cli'
}
```

- A web-session token (`type: 'access'`) has no scope claim → treated as
  **all scopes** (UI behaviour unchanged).
- An OAuth token (`type: 'oauth_access'`) is limited to its `scope` claim.

### Unified Bearer auth (`createJwtAuth` extension)

`createJwtAuth` in `middleware/auth.ts` is extended to accept three kinds of
Bearer credential:

1. JWT (`type: 'access'`) → web session. `authScopes = ALL`.
2. JWT (`type: 'oauth_access'`) → `authScopes = parse(scope)`.
3. A `crowi_pat_`-prefixed opaque token → hashed with SHA-256 and looked up
   in `PersonalAccessToken`. `authScopes = record.scopes`; expired / revoked
   tokens are rejected and `lastUsedAt` is bumped.

In every case, in addition to `c.set('user', user)`, it sets
`c.set('authScopes', Set<string>)` and `c.set('authContext', { kind, clientId? })`.

### `requireScope(scope)` middleware

New. It checks `c.get('authScopes')` against the implication rule and, on a
shortfall, returns `403 INSUFFICIENT_SCOPE`
(`WWW-Authenticate: Bearer error="insufficient_scope"`). It is layered onto
existing routes:

```
app.use('/pages/*', createJwtAuth(crowi))      // existing
// per openapi route, by method:
//   GET    → requireScope('pages:read')
//   POST/PUT/DELETE → requireScope('pages:write')
```

A web session has `authScopes = ALL`, so it always passes and behaviour is
unchanged.

## Mongoose models (new)

```
OAuthClient
  clientId        string (unique)        // seed 'crowi-cli'
  name            string
  type            'public' | 'confidential'
  secretHash?     string                 // confidential only
  redirectUris    string[]               // loopback: host match, any port
  allowedScopes   string[]
  firstParty      boolean
  trusted         boolean                // consent still shown in v1
  createdAt

OAuthAuthorizationCode  (TTL ~60s)
  codeHash, clientId, userId, scopes[],
  codeChallenge, codeChallengeMethod ('S256'),
  redirectUri, expiresAt, consumedAt?

OAuthDeviceCode  (TTL ~10min)
  deviceCodeHash, userCode (BCDFGHJKMNPQRSTVWXZ + digits, ABCD-1234),
  clientId, requestedScopes[], grantedScopes[]?,
  status 'pending'|'approved'|'denied',
  userId?, expiresAt, interval, lastPolledAt?

OAuthRefreshToken
  tokenHash, clientId, userId, scopes[],
  expiresAt, createdAt, revokedAt?, rotatedTo?  // reuse detection → chain revoke

PersonalAccessToken
  tokenHash, userId, name, scopes[],
  expiresAt? (null = non-expiring), lastUsedAt?, createdAt, revokedAt?
```

Every token secret is stored as a SHA-256 hash only (dropping the legacy
`apiToken`'s plaintext-searchable design).

## Endpoints

### OAuth standard (public routes)

| method/path | role |
|---|---|
| `POST /oauth/token` | grant_type: `authorization_code` / `refresh_token` / `urn:ietf:params:oauth:grant-type:device_code`. Returns access (JWT) + refresh + expires_in + scope |
| `POST /oauth/revoke` | revoke a refresh token / PAT (RFC 7009) |
| `POST /oauth/device/authorize` | device_code, user_code, verification_uri(_complete), interval, expires_in |
| `GET /.well-known/oauth-authorization-server` | discovery metadata (RFC 8414): issuer / token / authorization / device / revocation endpoints, `scopes_supported`, `code_challenge_methods_supported: ['S256']`, `grant_types_supported`. Lets the CLI/SDK auto-discover endpoints, and helps future arbitrary-app support. All URLs are built from `CLIENT_URL` (see Security considerations) |

### Consent / confirmation (under JWT auth = logged-in web user)

| method/path | role |
|---|---|
| `POST /oauth/authorize` | called by the consent screen. Validates the PKCE challenge + scopes, issues an authorization code, returns the redirect_uri |
| `POST /oauth/device/verify` | device `user_code` entry + approve/deny |

> The "consent screen" equivalent of `GET /oauth/authorize` is served by a
> **Next.js page** (below), not Hono. The Hono side only exposes the
> code-issuing API.

### PAT management (under `/me`, replaces legacy `/me/apiToken`)

| method/path | role |
|---|---|
| `GET /me/access-tokens` | list (metadata only, never the token body) |
| `POST /me/access-tokens` | issue with name + scopes + expiresAt. **Returns the plaintext only at creation** |
| `DELETE /me/access-tokens/:id` | revoke |

## Web (Next.js) — `(auth)` group

- `(auth)/oauth/authorize` — consent screen. Reads the query (`client_id` /
  `scope` / `redirect_uri` / `code_challenge` / `state`), shows the client
  name and requested scopes as a read/write checklist → on approval
  `POST /api/oauth/authorize` → navigates to the returned redirect_uri.
- `(auth)/oauth/device` — `user_code` entry → the same consent →
  `POST /api/oauth/device/verify`.
- Settings screen (`(auth)/me`, access-tokens section) — PAT issue / list /
  revoke UI.

## CLI flow (illustrative)

```
# Auth Code + PKCE
crowi login
  → generate verifier/challenge, start a loopback server (127.0.0.1:<rnd>)
  → browser opens /oauth/authorize?...&code_challenge=...&scope=pages:write+...
  → consent → callback?code=...&state=...
  → POST /oauth/token (code + verifier) → store tokens (~/.config/crowi)

# Device flow (no browser)
crowi login --device
  → POST /oauth/device/authorize
  → prints "go to https://wiki/oauth/device and enter ABCD-1234"
  → poll POST /oauth/token on the interval → tokens once approved
```

## External Markdown push (page editing)

No new endpoint needed. A token holding `pages:write` calls the existing
`PUT /api/pages` (`Page.updatePage` → `Revision.prepareRevision` →
`pushRevision`) / `POST /api/pages`. This path creates a revision directly
without going through collab (Y.Doc). Under RFC-0009's text-diff design an
external/API edit needs no special handling either — the next save simply
diffs against the previous body string (RFC-0009 OQ-F).

Conflict detection reuses the existing `revision_id` check
(`Page.isUpdatable`). The SDK must send the `revision_id` it fetched when
updating.

## Legacy `apiToken` removal (no fallback)

Removed:

- `models/user.ts`: the `apiToken` field, `generateApiToken`,
  `updateApiToken`, `findUserByApiToken`
- `middleware/auth.ts`: the unused `accessTokenParser` and non-cookie legacy
  path
- `handlers/me.ts`: `GET/POST /me/apiToken`
- the corresponding api-contract route / the web API-token UI

Migration: existing `apiToken` users must reissue a PAT (no compat layer is
needed since this is not yet in production — consistent with project memory
`feedback_api_v2_no_backcompat`).

## Security considerations

- **PKCE required** (public client). Only `code_challenge_method=S256` is
  allowed.
- **redirect_uri**: for the first-party CLI, only loopback (`127.0.0.1` /
  `localhost`, any port) is allowed; everything else must match exactly.
- **Refresh rotation + reuse detection**: re-presenting a used refresh token
  revokes the whole chain.
- Access tokens are short-lived (1h default). Revocation is handled on the
  refresh / PAT side (access tokens are stateless, so they are not revoked
  immediately — acceptable given the short lifetime).
- All token secrets are hashed at rest; the plaintext is returned exactly
  once at issuance.
- The consent screen lists scopes at read/write granularity.
- `INSUFFICIENT_SCOPE` is returned as 403 + `WWW-Authenticate`.
- **Public URLs are pinned to `CLIENT_URL`**: the discovery `issuer` /
  `authorization_endpoint` / token / revocation / device endpoints, and the
  device-flow `verification_uri`, are all built from the trusted `CLIENT_URL`
  (the web client's public origin). They are **not** derived from the request
  `Host` / `X-Forwarded-Host` header — those are attacker-controllable, and a
  forged Host could poison the discovery document / `verification_uri` and
  steer a victim to an attacker origin. `app:url` is Host-derived and is no
  longer trusted (retired). API endpoints (`token`, etc.) assume the default
  deployment reverse-proxies `/api` on the same origin, i.e.
  `{CLIENT_URL}/api/...`.

## Implementation phases

1. **Scope foundation** — `SCOPES` catalog (api-contract), `jwt.ts` claim
   extension, scope-aware `createJwtAuth`, `requireScope` middleware,
   per-method scope on existing routes. Web sessions keep all scopes, so
   behaviour is unchanged.
2. **PAT** — `PersonalAccessToken` model + `/me/access-tokens` + web UI.
   **Remove the legacy `apiToken`.**
3. **Auth Code + PKCE** — `OAuthClient` model + seed,
   `OAuthAuthorizationCode`, `OAuthRefreshToken` (rotation),
   `POST /oauth/token` (authorization_code / refresh_token),
   `POST /oauth/revoke`, `GET /.well-known/oauth-authorization-server`
   (discovery), the Next.js consent screen.
4. **Device flow** — `OAuthDeviceCode` model, `device/authorize` + the device
   grant on the token endpoint + `device/verify` + the web entry screen.
5. **(future) Admin client-registration UI** — confidential client /
   redirect_uri management. A separate admin section from RFC-0001's plugin
   auth (inbound).

Each phase carries one changeset (`minor`, `@crowi/api` +
`@crowi/api-contract`, plus `@crowi/web` when there are web changes).

## Resolved questions

- **OQ-A (resolved)**: immediate access-token revocation is **not needed in
  v1**. "Short lifetime (1h default) + revocation on the refresh / PAT side"
  is sufficient. Access tokens stay stateless (no DB introspection).
- **OQ-D (resolved)**: the discovery metadata
  (`GET /.well-known/oauth-authorization-server`, RFC 8414) **is provided in
  v1**, included in phase 3.

## Open questions

- **OQ-B**: the implication rule adopts "`write` includes the same resource's
  `read`"; should we instead require both explicitly (a separate read)? →
  proceeding with implication.
- **OQ-C**: should a PAT be allowed `admin:*`? Not in v1 (admin is web-session
  only); reserved only.
