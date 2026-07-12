---
"@crowi/api": minor
---

Enforce a 32-character minimum length for `WS_TOKEN_SECRET` — the shared HMAC signing key behind realtime collab, presence, notifications, and mail tokens — as part of the boot-time environment validation added in a previous release.

A value that is set but shorter than 32 characters now aborts boot under `NODE_ENV=production` (also the default when `NODE_ENV` is unset), with an error naming the variable, its current length, the required minimum, and how to generate a strong one (`openssl rand -base64 32`). Under any other `NODE_ENV` (`development`, `test`, ...) the same condition only produces a warning in the consolidated boot-time report, so local development is unaffected. Unset values, values of 32 characters or more, and known placeholder values (still treated as unconfigured, falling back to a random per-process secret as before) are all unaffected by this change.

This closes a gap where an operator could set a trivially guessable secret (e.g. a dictionary word) that was neither empty nor a known placeholder, and it would silently be accepted as a "configured" signing key for password-reset and invite mail tokens.
