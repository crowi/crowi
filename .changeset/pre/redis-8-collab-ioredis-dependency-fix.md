---
"@crowi/api": patch
---

Fixed a bug where the collaborative-editing Redis extension (`buildCollabRedisExtension`, only active when `REDIS_URL` is set) failed to load `ioredis` at runtime, because `ioredis` was never declared as a direct dependency of `@crowi/api` — it was only reachable through pnpm's isolated `node_modules` layout as a transitive dependency of `@hocuspocus/extension-redis`, which `require('ioredis')` from `@crowi/api`'s own source cannot resolve. This broke every multi-instance deployment with `REDIS_URL` configured: the process would throw `Cannot find module 'ioredis'` the first time a collaborative-editing WebSocket connection was authenticated. `ioredis` is now declared directly, matching the version already resolved elsewhere in the workspace. Discovered while adding real-Redis-8 smoke test coverage for this exact code path (feature-redis-8-upgrade Phase 2); unrelated to the Redis 7→8 version change itself.
