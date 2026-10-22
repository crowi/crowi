---
'@crowi/web': patch
---

Fixed `GET /.well-known/oauth-authorization-server` returning a 500 in self-hosted production. `next.config.ts`'s `rewrites()` used to proxy that path to an absolute API URL that gets frozen into `routes-manifest.json` at `next build` time for `output: 'standalone'` builds; since the Docker image never sets that build-time URL, it always baked in the dev fallback (`http://localhost:4301`), and nothing listens on that port inside the production web container. `next.config.ts` is now exported as a phase-gated function so this rewrite is only included for `next dev` (where the destination is evaluated fresh from the environment each time the dev server starts, so it always stays correct); production builds no longer carry it at all, so web never attempts to proxy this path itself.
