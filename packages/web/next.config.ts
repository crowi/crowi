import path from 'node:path';
import type { NextConfig } from 'next';
import { PHASE_DEVELOPMENT_SERVER, type PHASE_TYPE } from 'next/constants';

// Proxy target for the `rewrites()` below — the URL the Next server uses to
// reach the api (not the browser; a server-runtime env, NOT `NEXT_PUBLIC_*`).
//
// IMPORTANT: with `output: 'standalone'`, `rewrites()` is evaluated at BUILD
// time and the destination is frozen into `routes-manifest.json`; the runtime
// `node server.js` does NOT re-evaluate it. So `CROWI_API_URL` set on a built
// image does NOT change where the standalone server proxies. `next dev`
// evaluates config once at dev-server STARTUP (not per request, and not
// baked into a build artifact) — `CROWI_API_URL` set in the environment
// before `pnpm dev` launches `next dev` (see `scripts/dev.mjs`) is what this
// picks up, and it stays correct for the life of that dev server. Vercel's
// edge similarly needs `CROWI_API_URL` set as a build-time env, since it
// also freezes `rewrites()` from its build. For SELF-HOST production the
// recommended topology is a front reverse proxy that routes `/api`,`/files`,
// WS to the api — there Next never proxies `/api` and this rewrite is
// unused. See operations/deployment.
const API_URL = process.env.CROWI_API_URL || process.env.NEXT_PUBLIC_API_URL || 'http://localhost:4301';

// Hosts allowed to reach Next.js dev resources (`/_next/*`, HMR) from a
// different origin — e.g. testing from another LAN device or over Tailscale.
// Next blocks cross-origin dev requests by default; list the extra hosts in
// `ALLOWED_DEV_ORIGINS` (comma-separated) to permit them. Dev-only and
// machine-specific, so set it in a gitignored `packages/web/.env.local`
// (e.g. `ALLOWED_DEV_ORIGINS=10.0.3.109,my-host.tailnet.ts.net`) rather than
// committing it. No effect on production builds.
const ALLOWED_DEV_ORIGINS = process.env.ALLOWED_DEV_ORIGINS?.split(',')
  .map((s) => s.trim())
  .filter(Boolean);

// next.config is exported as a FUNCTION (phase) => NextConfig — Next's
// documented function-config form, called with the build/dev phase as the
// first argument (a second `{ defaultConfig }` argument is also passed but
// unused here) — rather than a plain object, specifically so `rewrites()`
// can vary by phase.
// `output: 'standalone'` freezes `rewrites()` into `routes-manifest.json` at
// `next build` (PHASE_PRODUCTION_BUILD) — see the API_URL comment above — so
// any rewrite destination that depends on a build-time env (like API_URL's
// `localhost:4301` fallback) must never be returned for that phase, or it
// ships baked into the production image with no way to reconfigure it at
// runtime. `next dev` runs as PHASE_DEVELOPMENT_SERVER and evaluates config
// once when the dev server starts (not frozen into a build artifact), so it
// doesn't have this problem.
//
// PATTERN FOR FUTURE OAuth METADATA ROUTES (e.g. RFC 9728
// `/.well-known/oauth-protected-resource`, not implemented yet — see the
// `.well-known` rewrite below): do NOT add a new web rewrite for it. Route
// `/.well-known/*` to the api at the front proxy (Caddyfile's `@api`
// matcher) instead, the same fix applied here for
// `oauth-authorization-server`, and rely on same-origin delivery in prod. A
// web-side rewrite is only safe for phases where the destination is
// re-evaluated at dev-server startup from the current env (dev); standalone
// prod freezes it into a build artifact instead, so it is not one of them.
function nextConfig(phase: PHASE_TYPE): NextConfig {
  return {
    ...(ALLOWED_DEV_ORIGINS?.length ? { allowedDevOrigins: ALLOWED_DEV_ORIGINS } : {}),

    // Produce a self-contained `.next/standalone/` build that bundles only the
    // files traced by Next's module dependency walker (server.js + minimal
    // node_modules + workspace deps). The output is what the Docker runtime
    // image copies — no `pnpm install` is needed at runtime. See
    // `packages/web/Dockerfile`.
    output: 'standalone',

    // In a pnpm monorepo, Next's tracing defaults to the package root
    // (`packages/web/`), which would miss workspace deps like
    // `@crowi/api-contract`. Set the tracing root to the repo root so all
    // workspace packages reachable from the web app are pulled into the
    // standalone bundle. Without this, `node server.js` at runtime fails
    // to resolve `@crowi/api-contract`.
    // `import.meta.dirname` (Node 20.11+) keeps this working if Next ever
    // switches to ESM config evaluation; bare `__dirname` would throw.
    outputFileTracingRoot: path.join(import.meta.dirname, '../../'),

    // Disable automatic trailing slash redirects
    // Crowi treats paths with and without trailing slashes as different pages:
    // - With trailing slash: portal/directory page
    // - Without trailing slash: page itself
    skipTrailingSlashRedirect: true,

    // Proxy `/api/v2/*` to the Crowi API server (`CROWI_API_URL`). In dev the
    // API runs on a different port (4301) than the web app (4302), so relative
    // URLs in markdown / `<img src>` would otherwise fail with cross-origin
    // 404. In the recommended same-origin self-host setup the browser hits
    // `/api/v2/...` on its own origin and this rewrite forwards to the api
    // container (`CROWI_API_URL=http://api:3000`).
    //
    // Collab WebSocket (`/collab/:pageId`) is intentionally NOT
    // proxied here: Next.js `rewrites()` is HTTP-only and does not
    // forward `upgrade` events. The client instead derives the WS URL
    // from `window.location` (or `NEXT_PUBLIC_COLLAB_URL` when set) in
    // `resolve-ws-url.ts` (used by `use-collab-document.ts` and the
    // presence/notifications hooks); an outer reverse proxy must route
    // `/collab/*` (and `/presence/*`, `/notifications/*`) WS upgrades to
    // the api. This is true in dev too (feature-dev-portal-worktree): `pnpm
    // dev` fronts api+web+the WS namespaces behind one same-origin proxy per
    // worktree (Caddy, or a zero-dep fallback — see `scripts/dev-caddy.mjs`),
    // so the client dialing its own origin reaches the api the same way dev
    // and prod do.
    async rewrites() {
      const rewrites = [
        { source: '/api/v2/:path*', destination: `${API_URL}/api/v2/:path*` },
        // Legacy attachment redirects (Crowi 1.x `/files/<id>` URLs embedded
        // in old page bodies) — forwarded to the api, which responds with a
        // 302 to `/api/v2/attachments/<id>` (the `/files/:id` redirect in
        // `attachment-stream.ts`, restored by feature-migration-files-url-
        // rewrite §3 as a safety net for bodies the body migration hasn't
        // rewritten). The browser then resolves the redirect target through
        // the `/api/v2/:path*` rewrite above.
        { source: '/files/:id', destination: `${API_URL}/files/:id` },
      ];

      // OAuth Authorization-Server Metadata (RFC 8414). The discovery
      // document is served by the api at the server root (NOT under
      // `/api/v2`), but its `issuer` is `CLIENT_URL` (this web origin).
      // External clients (e.g. `@crowi/cli`) fetch discovery from the
      // issuer origin and require `issuer === <the URL they dialed>`
      // (metadata mix-up defense), so the issuer origin must serve the
      // document.
      //
      // DEV ONLY: this rewrite exists so `:4302` is a complete origin when
      // hit directly, forwarding to the dev api port. It must NOT ship in a
      // production `output: 'standalone'` build — `rewrites()` is frozen
      // into `routes-manifest.json` at `next build` time (PHASE_PRODUCTION_
      // BUILD), so this destination would bake in whatever `API_URL`
      // resolved to at build time (`localhost:4301` when `CROWI_API_URL` is
      // unset, which it always is in `packages/web/Dockerfile`). At runtime
      // nothing listens on that port in the container, so every request
      // 500s (ECONNREFUSED) instead of reaching the api. In prod this path
      // must instead be handled by the front reverse proxy routing
      // `/.well-known/*` to the api alongside `/api` and `/files` (see the
      // repo root `Caddyfile`'s `@api` matcher and operations/deployment) —
      // same-origin delivery without web ever proxying it. Do NOT "fix"
      // this by swapping in a different absolute URL or reading
      // `process.env` at runtime instead: `output: 'standalone'` still
      // freezes it at build time either way.
      //
      // ALTERNATIVES CONSIDERED AND REJECTED for prod:
      // - relative rewrite (`destination: '/.well-known/oauth-authorization-
      //   server'` pointed at "wherever the front proxy sends it"): rejected
      //   because Next's rewrite destination is always resolved on THIS
      //   origin — a relative destination here would just re-enter web's own
      //   router (the discovery path has no page/route in web), not hop out
      //   to the front proxy. It only works at all once the front proxy
      //   already routes `.well-known` straight to the api (this fix's other
      //   half), and at that point web doesn't need to rewrite the path
      //   itself — the request never reaches web.
      // - `app/.well-known/oauth-authorization-server/route.ts` (a route
      //   handler that fetches the api server-side and re-serves the JSON):
      //   rejected because it adds a permanent runtime code path (an extra
      //   server-side fetch + error handling for every discovery request) to
      //   solve a problem the front-proxy fix already solves for prod, and it
      //   still needs an api base URL from somewhere at runtime — the same
      //   "how does web know where the api is" problem this fix sidesteps by
      //   not having web serve this path in prod at all.
      // - middleware (`middleware.ts` intercepting the path and proxying/
      //   redirecting): rejected as the heaviest option — middleware runs on
      //   the Edge runtime for every matched request, and it has the exact
      //   same "where's the api" runtime-config problem as the route-handler
      //   option, for no benefit over just not routing this path to web.
      if (phase === PHASE_DEVELOPMENT_SERVER) {
        rewrites.push({
          source: '/.well-known/oauth-authorization-server',
          destination: `${API_URL}/.well-known/oauth-authorization-server`,
        });
      }

      return rewrites;
    },
  };
}

export default nextConfig;
