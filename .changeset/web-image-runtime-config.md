---
"@crowi/web": minor
---

Make the web Docker image runtime-configurable so a single `crowi/crowi-web`
image can target any api without a rebuild — for both same-origin and
cross-origin topologies.

**Same-origin (reverse-proxy, default):** the browser always talks to relative
paths (`/api`, `/files/...`) on its own origin, and the Next server's
`rewrites()` proxy forwards them to the api at the runtime-injected
`CROWI_API_URL` server env (read at boot, not baked into the client bundle).
WebSocket endpoints (collab / presence / notifications) derive their URL from
`window.location` by default, so realtime works same-origin with no build-time
URL bake. The Dockerfile no longer accepts a `NEXT_PUBLIC_API_URL` build-arg.

**Cross-origin (split web/api hosts):** `NEXT_PUBLIC_API_URL` /
`NEXT_PUBLIC_COLLAB_URL` are now read at runtime via `next-runtime-env`
(`<PublicEnvScript />` in the root layout injects the operator's start-time env;
the client reads it instead of a build-time-inlined value). A single image can
therefore be pointed at any api origin (HTTP + WS) just by setting those env
vars at container start — no rebuild required. The api side needs `CLIENT_URL`
set to the web origin for CORS (documented in the deployment topologies guide).

`NEXT_PUBLIC_API_URL` is still honored as a dev / Vercel build-time fallback, so
`pnpm dev` and Vercel deployments are unchanged. Env-unset deployments keep the
previous same-origin behavior (relative paths + `window.location` WS).
