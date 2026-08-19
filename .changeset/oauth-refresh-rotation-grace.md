---
"@crowi/api": patch
"@crowi/cli": patch
---

Two or more processes refreshing the same OAuth refresh token at nearly the same time no longer forces a re-login. The server now suppresses rotation-reuse-chain revocation for a short grace window (default 60s, tunable via `OAUTH_REFRESH_REUSE_GRACE_MS`, `0` restores the previous immediate-revocation behavior) after a token is rotated away, while still returning the exact same `400 invalid_grant` response and never issuing a token on the suppressed path — reuse outside the window, and explicit `POST /oauth/revoke` calls, still revoke the whole chain exactly as before. The CLI (`crowi`) now recovers automatically on the losing side of such a race: when a refresh fails, it re-reads the locally stored profile and retries once with the refresh token a concurrent `crowi` process already rotated to, instead of surfacing a spurious session-expired error.
