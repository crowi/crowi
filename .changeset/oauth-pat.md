---
'@crowi/api-contract': minor
'@crowi/api': minor
'@crowi/web': minor
---

Add Personal Access Tokens and remove the legacy API token (RFC-0010 Phase 2).

Users can now issue scoped, optionally-expiring Personal Access Tokens
(PATs) from the settings screen to drive the API from scripts and the
CLI. A PAT is an opaque `crowi_pat_…` Bearer token; only its SHA-256 hash
is stored and the plaintext is shown exactly once at creation. New
endpoints: `GET /me/access-tokens` (metadata only), `POST
/me/access-tokens` (issue), `DELETE /me/access-tokens/:id` (revoke). The
unified Bearer auth middleware accepts `crowi_pat_` tokens, applies the
token's scopes, rejects revoked / expired tokens, and updates
`lastUsedAt`. Issuable scopes exclude `admin:*`; token management is
web-session only (a PAT or OAuth token cannot mint a new PAT).

**Breaking:** the legacy `User.apiToken` and its `GET/POST /me/apiToken`
endpoints are removed with no compatibility shim — existing API-token
users must re-issue a Personal Access Token.
