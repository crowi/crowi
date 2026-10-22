---
"@crowi/api": minor
---

Redis 8.x is now the reference version Crowi tests and supports (previously Redis 7.x). `docker-compose.yml`'s `redis` service moved off the moving `redis:7` tag to a reviewed, digest-pinned Redis 8.x patch tag, and CI now runs the same pinned tag as a service in the `test` and `flake-report` jobs, plus a dedicated `crowi-test-redis` instance so a Config pub/sub smoke test can safely publish to the fixed, global `'config'` channel without waking up any other process sharing the Redis instance. A TLS-only fixture (`crowi-test-redis-tls` locally, an equivalent post-checkout `docker run` step in CI) reuses the existing self-signed test certs to exercise `rediss://` connectivity.

This is a documentation/test-support policy change only: no code rejects Redis 7.x connections, and existing self-hosted Redis 7 deployments keep working unchanged. CI and `docker compose up -d` now exercise exactly one pinned Redis 8.x patch tag — this is not a claim that every version in the `>=8.0 <9` range has been individually verified.
