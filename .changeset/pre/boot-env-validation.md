---
"@crowi/api": minor
---

Validate every Crowi-owned environment variable in a single pass at boot instead of the previous ad hoc mix of throw / warn / silent-fallback behavior scattered across the codebase.

- `PORT`, `MONGO_URI` (or its legacy aliases), `REDIS_URL` (or its legacy aliases), and `CROWI_ENCRYPTION_KEY` now fail boot immediately with one error message listing every malformed variable, instead of surfacing a confusing low-level error later (a bad `PORT` used to only fail once `server.listen()` ran, a bad `MONGO_URI` only once the driver tried to connect).
- `CLIENT_URL`, `CROWI_MULTI_INSTANCE`, `NODE_ENV`, `JWT_ACCESS_TOKEN_TTL_SECONDS`, `JWT_REFRESH_TOKEN_TTL_SECONDS`, `COLLAB_MAX_EDITORS_PER_PAGE`, and `MIGRATION_PREFLIGHT_UNAPPLIED_POLICY` now print a single consolidated boot-time warning when malformed, instead of silently falling back to a default or (for `CROWI_MULTI_INSTANCE`) being misinterpreted as truthy.
- An environment variable that carries a known Crowi prefix (`CROWI_`, `WS_TOKEN_`, `JWT_`, `COLLAB_`, `REDIS*`, `MONGO*`, `MIGRATION_`) but matches no known variable name — a likely typo — is flagged in the same warning report.

Well-formed configurations are unaffected; only malformed values that previously failed silently or late now surface at boot.
