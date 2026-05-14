import path from 'node:path';
import type { NextConfig } from 'next';

const API_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3300';

const nextConfig: NextConfig = {
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

  // Proxy `/api/v2/*` and `/collab/*` to the Crowi API server. In dev
  // the API runs on a different port (3300) than the web app (3301), so
  // relative URLs in markdown / `<img src>` would otherwise fail with
  // cross-origin 404. In production the operator typically runs both
  // behind a single domain — `NEXT_PUBLIC_API_URL` then points at the
  // same origin and the rewrite is a no-op pass-through.
  //
  // `/collab/:pageId` is the WebSocket endpoint the embedded Hocuspocus
  // engine answers on (RFC-0003 Phase 9). Next.js forwards the
  // `upgrade` header through the rewrite so dev hot-reload works with
  // the location-derived `ws://<window.location.host>/collab/<pageId>`
  // default — no `NEXT_PUBLIC_COLLAB_URL` env required.
  async rewrites() {
    return [
      { source: '/api/v2/:path*', destination: `${API_URL}/api/v2/:path*` },
      { source: '/collab/:path*', destination: `${API_URL}/collab/:path*` },
      // Legacy attachment redirects (Crowi 1.x URLs embedded in old
      // page bodies) — Express side responds with a 302 to /api/v2/...,
      // which the browser will resolve through the rewrite above.
      { source: '/files/:id', destination: `${API_URL}/files/:id` },
    ];
  },
};

export default nextConfig;
