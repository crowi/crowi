---
'@crowi/api-contract': minor
'@crowi/api': minor
'@crowi/web': minor
---

Add the OAuth 2.0 Device Authorization Grant (RFC 8628, RFC-0010 Phase 4),
completing the OAuth authorization-server foundation.

Headless clients (CLIs, CI) that cannot open a browser can now obtain
scoped tokens via the device flow:

- `POST /oauth/device/authorize` (public) validates the client and
  requested scopes and issues a `device_code` (returned once, stored as a
  SHA-256 hash), a human-typed `user_code` (`ABCD-1234`, ambiguous glyphs
  excluded), `verification_uri` + `verification_uri_complete`, `expires_in`
  (~10min) and the poll `interval`.
- `POST /oauth/token` gains the
  `urn:ietf:params:oauth:grant-type:device_code` grant. Polling returns
  `authorization_pending` until the user acts, `slow_down` when polled
  faster than the interval, `access_denied` on denial, `expired_token` past
  the TTL, and on approval mints an access-token JWT + refresh token
  (atomic single-use consume).
- `GET /oauth/device` (public) looks up a pending authorization by
  `user_code`, returning only the requesting client and requested scopes so
  the consent screen can display them.
- `POST /oauth/device/verify` (web-session only) approves or denies a
  `user_code`.
- Discovery now advertises the device grant URN and
  `device_authorization_endpoint`.

A new consent screen at `/oauth/device` accepts the `user_code` (prefilled
from `verification_uri_complete`), reuses the authorize-code consent card,
and confirms once the user can return to the CLI.
