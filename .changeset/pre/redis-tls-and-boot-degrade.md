---
"@crowi/api": patch
---

Fix `rediss://` URLs silently connecting in plaintext: the Redis socket options passed a nested `tls: {...}` object, but node-redis v4 selects the TLS transport only on the literal `tls: true` with the TLS options flattened into the socket object — so TLS (and `REDIS_REJECT_UNAUTHORIZED`) was silently ignored. Also fix boot hanging forever when Redis is configured but unreachable: the initial boot connection is now bounded (~10 attempts) and degrades to "Continuing without Redis" as documented, config pub/sub setup skips connecting when the boot connection degraded, and the pub/sub clients gained error listeners so a steady-state Redis outage no longer crashes the process. Steady-state reconnect behaviour after an established connection is unchanged.
