---
'@crowi/api-contract': minor
'@crowi/api': minor
'@crowi/web': minor
---

Add an OAuth 2.0 authorization-server foundation so the Crowi CLI / SDK can
drive the API "as a user" with scoped, revocable tokens, and replace the
legacy API token (RFC-0010).

- **Scopes** — per-resource read/write scopes with a canonical `SCOPES`
  catalog and a `scopeSatisfies` implication helper (write→read, umbrella
  read/write) from `@crowi/api-contract`. The unified Bearer middleware is
  scope-aware and a `requireScope(...)` guard is applied per route. Web
  sessions hold all scopes (UI behaviour unchanged); insufficient scope
  returns `403 INSUFFICIENT_SCOPE` with a `WWW-Authenticate` header.
- **Personal Access Tokens** — issue scoped, optionally-expiring
  `crowi_pat_…` tokens from the settings screen (`GET/POST/DELETE
  /me/access-tokens`); only the SHA-256 hash is stored, the plaintext is
  shown once, and token management is web-session only. **Breaking:** the
  legacy `User.apiToken` and `GET/POST /me/apiToken` are removed with no
  compatibility shim — existing API-token users must re-issue a PAT.
- **Authorization Code + PKCE** — `POST /oauth/authorize` (web-session only)
  + `POST /oauth/token` (authorization code with `S256`, or refresh-token
  rotation with reuse detection that revokes the whole chain) + `POST
  /oauth/revoke` (RFC 7009) + a consent screen. A first-party `crowi-cli`
  public client is seeded idempotently at boot.
- **Device Authorization Grant** (RFC 8628) — `POST /oauth/device/authorize`,
  the `urn:ietf:params:oauth:grant-type:device_code` token grant
  (`authorization_pending` / `slow_down` / `access_denied` / `expired_token`),
  `GET /oauth/device` + `POST /oauth/device/verify`, and a `user_code`
  consent screen for headless clients.
- **Discovery** — `GET /.well-known/oauth-authorization-server` (RFC 8414),
  with every public URL built from the trusted `CLIENT_URL` (never the
  request `Host`, which is attacker-controllable).
- **History** — each revision records its edit channel (`editVia`:
  `web` / `oauth` / `pat`); the page history view shows an "app" chip
  (tooltip: edited via the API with a token) next to the author for OAuth /
  PAT edits, so web vs API edits are distinguishable at a glance.

Access tokens are short-lived scope-bearing JWTs; refresh tokens,
authorization / device codes and PATs are stored as SHA-256 hashes only.
