---
"@crowi/api": minor
---

Scope every Redis key and pub/sub channel to the Crowi instance so multiple instances can safely share one Redis (Upstash, ElastiCache, a single VPS, etc.) without cross-talk.

Every Redis-backed consumer — collab pub/sub, the editor-cap counter, presence, notification invalidation, Config sync, rate limiting, and LRU (recently-viewed pages) — now builds its keys and channels through a shared `crowi:<instance-slug>:...` namespace instead of a bare `crowi:...` shape that collided across instances (most visibly, the presence feed channel was previously global, so instance A's viewer/editing updates leaked into instance B's WebSocket clients on a shared Redis).

The instance slug defaults to the hostname of `CLIENT_URL`, so replicas of the same public site automatically share a namespace while distinct sites get distinct ones with no extra configuration. Set the new `REDIS_KEY_PREFIX` env var to override it explicitly (required whenever `REDIS_URL` is set and no valid `CLIENT_URL` is configured — booting without a resolvable slug now aborts instead of silently defaulting).

`REDIS_URL`'s database-number path segment (e.g. `redis://host:6379/1`) is also now respected by both the node-redis and ioredis clients, which previously silently ignored it and always connected to DB 0. This is a secondary, purely numeric isolation axis — Redis pub/sub is not scoped to a DB, so `REDIS_KEY_PREFIX` (not the DB number) is what actually isolates instances sharing one Redis.
