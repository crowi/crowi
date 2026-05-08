import type { NextConfig } from 'next';

const API_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3300';

const nextConfig: NextConfig = {
  // Disable automatic trailing slash redirects
  // Crowi treats paths with and without trailing slashes as different pages:
  // - With trailing slash: portal/directory page
  // - Without trailing slash: page itself
  skipTrailingSlashRedirect: true,

  // Proxy `/api/v2/*` to the Crowi API server. In dev the API runs on a
  // different port (3300) than the web app (3301), so relative URLs in
  // markdown / `<img src>` would otherwise fail with cross-origin 404.
  // In production the operator typically runs both behind a single
  // domain — `NEXT_PUBLIC_API_URL` then points at the same origin and
  // the rewrite is a no-op pass-through.
  async rewrites() {
    return [
      { source: '/api/v2/:path*', destination: `${API_URL}/api/v2/:path*` },
      // Legacy attachment redirects (Crowi 1.x URLs embedded in old
      // page bodies) — Express side responds with a 302 to /api/v2/...,
      // which the browser will resolve through the rewrite above.
      { source: '/files/:id', destination: `${API_URL}/files/:id` },
    ];
  },
};

export default nextConfig;
