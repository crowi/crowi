---
"@crowi/api": patch
---

Upgrade the `redis` client dependency from 4.7.1 to 6.2.1. Redis-backed features (config sync, presence, rate limiting, LRU, editor-cap, link completion, collab) behave the same as before; `ioredis` (used by the realtime-collab Redis extension) stays on 5.x since the extension pins that major.
