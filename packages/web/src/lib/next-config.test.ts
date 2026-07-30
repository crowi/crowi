import { PHASE_DEVELOPMENT_SERVER, PHASE_PRODUCTION_BUILD, type PHASE_TYPE } from 'next/constants';
import { describe, expect, it } from 'vitest';
// `next.config.ts` lives at the package root (Next.js requires this), not
// under `src/`. Import it directly rather than duplicating its logic here —
// this test exists specifically to catch a regression where the
// `.well-known/oauth-authorization-server` rewrite (which bakes an
// environment-dependent absolute URL) leaks back into a production
// `output: 'standalone'` build. See the phase-gate comment in next.config.ts.
import nextConfig from '../../next.config';

async function resolvedRewrites(phase: PHASE_TYPE) {
  const config = nextConfig(phase);
  const rewrites = await config.rewrites?.();
  if (!rewrites) return [];
  // `rewrites()` may return either an array, or `{ beforeFiles, afterFiles,
  // fallback }` (unused here, but guard so a future change doesn't silently
  // break this test).
  return Array.isArray(rewrites) ? rewrites : (rewrites.afterFiles ?? []);
}

async function rewriteSources(phase: PHASE_TYPE) {
  return (await resolvedRewrites(phase)).map((r) => r.source);
}

describe('next.config rewrites() phase gating', () => {
  it('includes the .well-known/oauth-authorization-server rewrite in PHASE_DEVELOPMENT_SERVER, pointed at the api', async () => {
    const rewrites = await resolvedRewrites(PHASE_DEVELOPMENT_SERVER);
    const wellKnown = rewrites.find((r) => r.source === '/.well-known/oauth-authorization-server');
    expect(wellKnown?.destination).toBe('http://localhost:4301/.well-known/oauth-authorization-server');
  });

  it('omits the .well-known/oauth-authorization-server rewrite in PHASE_PRODUCTION_BUILD (standalone build)', async () => {
    // This is the regression this test guards: with `output: 'standalone'`,
    // whatever rewrites() returns during PHASE_PRODUCTION_BUILD gets frozen
    // into routes-manifest.json and shipped in the image, with no runtime
    // env able to change it. An absolute-URL destination here (e.g. the
    // `CROWI_API_URL` fallback `http://localhost:4301`) would ECONNREFUSED
    // in prod since nothing listens on that port in the web container.
    const sources = await rewriteSources(PHASE_PRODUCTION_BUILD);
    expect(sources).not.toContain('/.well-known/oauth-authorization-server');
  });

  it('keeps the /api and /files rewrites in every phase (unaffected by this fix)', async () => {
    const devSources = await rewriteSources(PHASE_DEVELOPMENT_SERVER);
    const prodSources = await rewriteSources(PHASE_PRODUCTION_BUILD);
    for (const sources of [devSources, prodSources]) {
      expect(sources).toContain('/api/:path*');
      expect(sources).toContain('/files/:id');
    }
  });
});
