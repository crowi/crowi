---
'@crowi/api-contract': minor
'@crowi/api': minor
'@crowi/web': minor
---

Turn Crowi into an OAuth 2.0 authorization server: Authorization Code +
PKCE flow, refresh-token rotation, and discovery (RFC-0010 Phase 3).

CLIs and native apps can now obtain scoped access tokens via the standard
Authorization Code + PKCE flow. New endpoints:

- `POST /oauth/authorize` (web-session only) validates the client, the
  PKCE `S256` challenge, the redirect URI (registered loopback hosts are
  matched on host with any port; other URIs must match exactly), and the
  requested scopes against the client's allowed set, then issues a
  short-lived single-use authorization code.
- `POST /oauth/token` exchanges an authorization code (+ PKCE
  `code_verifier`) or a refresh token for a scope-bearing access-token JWT
  plus a rotated refresh token. Refresh tokens are single-use; replaying a
  rotated token triggers reuse detection and revokes the whole rotation
  chain. Accepts `application/x-www-form-urlencoded` and JSON, and returns
  the RFC 6749 §5.2 error envelope.
- `POST /oauth/revoke` (RFC 7009) revokes a refresh token or a Personal
  Access Token; unknown tokens still return 200.
- `GET /.well-known/oauth-authorization-server` (RFC 8414) advertises the
  issuer, endpoints, supported scopes, `code_challenge_methods: ["S256"]`,
  and grant types.

A first-party `crowi-cli` public client is seeded idempotently at boot
(loopback redirects, PKCE-only). A new consent screen at
`/oauth/authorize` shows the requested scopes and authorizes the request.
Authorization codes and refresh tokens are stored as SHA-256 hashes only.
