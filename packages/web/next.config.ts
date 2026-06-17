import path from 'node:path';
import type { NextConfig } from 'next';

// Proxy target for the `rewrites()` below — the URL the Next server uses to
// reach the api (not the browser; a server-runtime env, NOT `NEXT_PUBLIC_*`).
//
// IMPORTANT: with `output: 'standalone'`, `rewrites()` is evaluated at BUILD
// time and the destination is frozen into `routes-manifest.json`; the runtime
// `node server.js` does NOT re-evaluate it. So `CROWI_API_URL` set on a built
// image does NOT change where the standalone server proxies — it only takes
// effect where the config is evaluated at request time: `pnpm dev` (next dev)
// and Vercel's edge (which proxies `rewrites()` per request; set CROWI_API_URL
// as a Vercel build env). For SELF-HOST production the recommended topology is a
// front reverse proxy that routes `/api`,`/files`,WS to the api — there Next
// never proxies `/api` and this rewrite is unused. See operations/deployment.
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

const nextConfig: NextConfig = {
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
  // `use-collab-document.ts`; the outer reverse proxy must route
  // `/collab/*` (and `/presence/*`, `/notifications/*`) WS upgrades to
  // the api. In dev the client derives from `NEXT_PUBLIC_API_URL`
  // (:4301) instead — cross-origin WS in dev is fine, browsers don't
  // enforce same-origin for WebSocket and Hocuspocus doesn't gate on
  // Origin.
  async rewrites() {
    return [
      { source: '/api/v2/:path*', destination: `${API_URL}/api/v2/:path*` },
      // OAuth Authorization-Server Metadata (RFC 8414). The discovery
      // document is served by the api at the server root (NOT under
      // `/api/v2`), but its `issuer` is `CLIENT_URL` (this web origin).
      // External clients (e.g. `@crowi/cli`) fetch discovery from the
      // issuer origin and require `issuer === <the URL they dialed>`
      // (metadata mix-up defense), so the issuer origin must serve the
      // document. In prod a single reverse proxy already routes it; in
      // dev the web app proxies it here so `:4302` is a complete origin.
      {
        source: '/.well-known/oauth-authorization-server',
        destination: `${API_URL}/.well-known/oauth-authorization-server`,
      },
      // Legacy attachment redirects (Crowi 1.x URLs embedded in old
      // page bodies) — Express side responds with a 302 to /api/v2/...,
      // which the browser will resolve through the rewrite above.
      { source: '/files/:id', destination: `${API_URL}/files/:id` },
    ];
  },
};

export default nextConfig;
