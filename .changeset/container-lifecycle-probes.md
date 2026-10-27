---
"@crowi/api": minor
---

Add unauthenticated `/healthz` (liveness) and `/readyz` (readiness: DB connected and not shutting down) endpoints, a `HEALTHCHECK` in the official Docker image, and make SIGTERM/SIGINT stop accepting connections and wait up to 8 seconds for in-flight HTTP requests and post-save background work (search index updates, notifications) before exiting.
