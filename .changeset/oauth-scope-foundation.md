---
'@crowi/api-contract': minor
'@crowi/api': minor
---

Add OAuth 2.0 scope foundation (RFC-0010 Phase 1).

The API now understands per-resource read/write scopes. A canonical
`SCOPES` catalog plus a `scopeSatisfies` implication helper
(write→read, umbrella read/write) ships from `@crowi/api-contract`. The
unified Bearer auth middleware accepts scope-bearing OAuth access tokens
(`type: 'oauth_access'`) alongside web-session tokens, and a new
`requireScope(...)` guard is applied per route across page / revision /
draft / backlink / search / autocomplete / comment / bookmark /
attachment / notification / me / user endpoints. Web sessions hold all
scopes, so existing UI behaviour is unchanged; insufficient OAuth scope
returns `403 INSUFFICIENT_SCOPE` with a `WWW-Authenticate` header.

(Token issuing endpoints — PAT, authorization code, device flow — land
in later phases.)
