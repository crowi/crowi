---
"@crowi/api": minor
"@crowi/web": minor
"@crowi/api-contract": minor
---

Add self-service OAuth session management under Settings > Security. Users can now see a list of the OAuth refresh-token rotation-chain tips issued to apps they've authorized (client name, granted scopes, when authorized, when last refreshed, and when it expires) and revoke any of them individually. Revoking stops future token refreshes reachable from that row, but an already-issued access token remains usable until it naturally expires (up to 1 hour by default) — there is no immediate-revocation mechanism for access tokens. The new `GET /me/oauth-sessions` and `DELETE /me/oauth-sessions/{id}` endpoints never expose the underlying token or its hash, and never include the browser's own web login session in the list.
