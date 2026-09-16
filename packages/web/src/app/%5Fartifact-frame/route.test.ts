import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// `public-runtime-env.ts` imports the `server-only` package, which is never
// an installed dependency here (Next.js aliases it internally for its own
// bundler) — Vitest has no `server-only` module to resolve, so the real
// file can never load under this test runner. Stubbing the whole module
// (rather than trying to alias/mock the unresolvable `server-only`
// specifier itself) sidesteps that entirely; the fake below reads
// `NEXT_PUBLIC_ARTIFACT_ORIGIN` live from `process.env` the same way the
// real implementation does, which is all this route's own logic exercises.
vi.mock('@/lib/public-runtime-env', () => ({
  readPublicRuntimeEnv: () => {
    const value = process.env.NEXT_PUBLIC_ARTIFACT_ORIGIN;
    return value ? { NEXT_PUBLIC_ARTIFACT_ORIGIN: value } : {};
  },
}));

async function importRoute() {
  return import('./route');
}

/**
 * Defaults the `Host` header to the URL's own host, matching what a direct
 * (non-proxied) request looks like. Pass `host` explicitly to simulate a
 * reverse-proxied request where the incoming `Host` header differs from
 * whatever `request.url` says — see the "Host header, not request.url"
 * tests below for why that distinction matters.
 */
function requestFor(url: string, opts?: { host?: string | null }): Request {
  const host = opts?.host === undefined ? new URL(url).host : opts.host;
  return new Request(url, host === null ? undefined : { headers: { host } });
}

/**
 * Extracts a single HTML attribute's exact value from the route's rendered
 * inner `<iframe>`. Used instead of `toContain(...)` + a list of excluded
 * tokens, which would still pass if an unexpected extra token (or an
 * un-anticipated forbidden one) were appended to the attribute.
 */
function iframeAttr(html: string, attr: string): string | null {
  const match = html.match(new RegExp(`<iframe\\b[^>]*\\s${attr}="([^"]*)"`));
  return match?.[1] ?? null;
}

beforeEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('ARTIFACT_FRAME_CSP', () => {
  it('builds the exact CSP string for a given frame-src token, pinned independently of any route response', async () => {
    const { ARTIFACT_FRAME_CSP } = await importRoute();

    expect(ARTIFACT_FRAME_CSP('https://artifacts.example.net')).toBe(
      "default-src 'none'; frame-src https://artifacts.example.net; style-src 'unsafe-inline'; frame-ancestors 'self'",
    );
    expect(ARTIFACT_FRAME_CSP('wiki.example.com')).toBe("default-src 'none'; frame-src wiki.example.com; style-src 'unsafe-inline'; frame-ancestors 'self'");
  });
});

describe('GET /_artifact-frame', () => {
  describe('NEXT_PUBLIC_ARTIFACT_ORIGIN configured (Mode A / separate-origin)', () => {
    beforeEach(() => {
      vi.stubEnv('NEXT_PUBLIC_ARTIFACT_ORIGIN', 'https://artifacts.example.net');
    });

    it('200s a matching src with the exact CSP (no `self`) and a single sandboxed inner iframe', async () => {
      const { GET } = await importRoute();
      const src = 'https://artifacts.example.net/api/artifact/p1/r1?t=tok';
      const res = await GET(requestFor(`https://wiki.example.com/_artifact-frame?src=${encodeURIComponent(src)}`));

      expect(res.status).toBe(200);
      expect(res.headers.get('Content-Type')).toBe('text/html; charset=utf-8');
      // Asserted against a literal string, NOT `ARTIFACT_FRAME_CSP(...)` —
      // building the expectation from the function under test would let a
      // regression in that function (an extra directive, a dropped
      // exclusion) pass silently. `frame-ancestors 'self'` is expected here
      // — it is `frame-src` that must never carry `'self'` (that would let
      // the artifact navigate its own frame back into the Crowi origin).
      expect(res.headers.get('Content-Security-Policy')).toBe(
        "default-src 'none'; frame-src https://artifacts.example.net; style-src 'unsafe-inline'; frame-ancestors 'self'",
      );

      const html = await res.text();
      const iframeMatches = html.match(/<iframe\b/g) ?? [];
      expect(iframeMatches).toHaveLength(1);
      // Exact attribute-value match, not substring + exclusion list — an
      // extra sandbox token appended to a valid prefix would still pass a
      // `toContain` check but must fail an exact `toBe`.
      expect(iframeAttr(html, 'sandbox')).toBe('allow-scripts');
      expect(iframeAttr(html, 'referrerpolicy')).toBe('no-referrer');
      expect(html).toContain(`src="${src}"`);
    });

    it('400s (text/plain) a src on a different host', async () => {
      const { GET } = await importRoute();
      const src = 'https://evil.example/api/artifact/p1/r1?t=tok';
      const res = await GET(requestFor(`https://wiki.example.com/_artifact-frame?src=${encodeURIComponent(src)}`));

      expect(res.status).toBe(400);
      expect(res.headers.get('Content-Type')).toBe('text/plain; charset=utf-8');
      expect(res.headers.get('Content-Security-Policy')).toBeNull();
      const body = await res.text();
      expect(body).not.toContain('<');
    });

    it('400s a src that differs only by scheme (exact-match required when configured)', async () => {
      const { GET } = await importRoute();
      const src = 'http://artifacts.example.net/api/artifact/p1/r1?t=tok';
      const res = await GET(requestFor(`https://wiki.example.com/_artifact-frame?src=${encodeURIComponent(src)}`));

      expect(res.status).toBe(400);
    });

    it('400s (text/plain) when src is missing', async () => {
      const { GET } = await importRoute();
      const res = await GET(requestFor('https://wiki.example.com/_artifact-frame'));

      expect(res.status).toBe(400);
      expect(res.headers.get('Content-Type')).toBe('text/plain; charset=utf-8');
      const body = await res.text();
      expect(body).not.toContain('<');
    });

    it('400s (text/plain, not 500) a src that fails to parse as a URL', async () => {
      const { GET } = await importRoute();
      const res = await GET(requestFor(`https://wiki.example.com/_artifact-frame?src=${encodeURIComponent('not a url')}`));

      expect(res.status).toBe(400);
      expect(res.headers.get('Content-Type')).toBe('text/plain; charset=utf-8');
      const body = await res.text();
      expect(body).not.toContain('<');
    });

    it('escapes the src attribute value', async () => {
      const { GET } = await importRoute();
      // `URL` itself percent-encodes `"` / `<` / `>` out of every component
      // (query/path/fragment), so those can never reach the HTML attribute
      // un-encoded regardless of this route's own escaping — `&` is the one
      // character that DOES survive URL serialization verbatim and still
      // needs HTML-attribute escaping, so it is what this test exercises.
      const src = 'https://artifacts.example.net/api/artifact/p1/r1?t=tok&foo=bar';
      const res = await GET(requestFor(`https://wiki.example.com/_artifact-frame?src=${encodeURIComponent(src)}`));

      expect(res.status).toBe(200);
      const html = await res.text();
      expect(html).toContain('t=tok&amp;foo=bar');
      expect(html.match(/<iframe\b/g) ?? []).toHaveLength(1);
    });

    it('re-reads NEXT_PUBLIC_ARTIFACT_ORIGIN at REQUEST time, not once at import/build time', async () => {
      // No `vi.resetModules()` / re-import between the two calls below — the
      // SAME `GET` closure must see a DIFFERENT env value on its second
      // invocation, proving `readPublicRuntimeEnv()` reads live rather than
      // caching whatever was configured when this module was first loaded.
      const { GET } = await importRoute();
      const srcA = 'https://artifacts.example.net/api/artifact/p1/r1?t=tok';
      const resA = await GET(requestFor(`https://wiki.example.com/_artifact-frame?src=${encodeURIComponent(srcA)}`));
      expect(resA.status).toBe(200);

      vi.stubEnv('NEXT_PUBLIC_ARTIFACT_ORIGIN', 'https://artifacts-b.example.net');

      const srcB = 'https://artifacts-b.example.net/api/artifact/p1/r1?t=tok';
      const resB = await GET(requestFor(`https://wiki.example.com/_artifact-frame?src=${encodeURIComponent(srcB)}`));
      expect(resB.status).toBe(200);

      // The ORIGINAL (now stale) origin must no longer validate.
      const resAAgain = await GET(requestFor(`https://wiki.example.com/_artifact-frame?src=${encodeURIComponent(srcA)}`));
      expect(resAAgain.status).toBe(400);
    });
  });

  describe('NEXT_PUBLIC_ARTIFACT_ORIGIN unset (Mode B / same-origin)', () => {
    it('derives the artifact origin from the request host (200 on host+port match, scheme ignored)', async () => {
      const { GET } = await importRoute();
      const src = 'https://wiki.example.com/api/artifact/p1/r1?t=tok';
      // The Node process behind a TLS-terminating proxy sees a plain `http`
      // request even though the browser's real connection is `https` — this
      // must still succeed.
      const res = await GET(requestFor(`http://wiki.example.com/_artifact-frame?src=${encodeURIComponent(src)}`));

      expect(res.status).toBe(200);
      // Literal string, not `ARTIFACT_FRAME_CSP(...)` — see the Mode A test
      // above for why.
      expect(res.headers.get('Content-Security-Policy')).toBe(
        "default-src 'none'; frame-src wiki.example.com; style-src 'unsafe-inline'; frame-ancestors 'self'",
      );
    });

    it('400s a src on a different host+port', async () => {
      const { GET } = await importRoute();
      const src = 'https://evil.example/api/artifact/p1/r1?t=tok';
      const res = await GET(requestFor(`http://wiki.example.com/_artifact-frame?src=${encodeURIComponent(src)}`));

      expect(res.status).toBe(400);
    });

    it('uses the CURRENT request host, not a build-time value — a later request with a different host is validated against itself', async () => {
      const { GET } = await importRoute();
      const firstHostSrc = 'https://wiki.example.com/api/artifact/p1/r1?t=tok';
      const secondHostSrc = 'https://wiki2.example.com/api/artifact/p1/r1?t=tok';

      const first = await GET(requestFor(`https://wiki.example.com/_artifact-frame?src=${encodeURIComponent(firstHostSrc)}`));
      expect(first.status).toBe(200);

      const second = await GET(requestFor(`https://wiki2.example.com/_artifact-frame?src=${encodeURIComponent(secondHostSrc)}`));
      expect(second.status).toBe(200);

      // Cross-checking against the OTHER request's host must fail — proves
      // neither response was served from a value pinned once at import time.
      const mismatched = await GET(requestFor(`https://wiki.example.com/_artifact-frame?src=${encodeURIComponent(secondHostSrc)}`));
      expect(mismatched.status).toBe(400);
    });

    it("derives the origin from the Host header, not from request.url's own host", async () => {
      // Reproduces a reverse-proxied deployment (Caddy/nginx in front of the
      // Next.js server on a different port): the framework's own router
      // rebuilds `request.url` from its internal bind address unless
      // `experimental.trustHostHeader` is set, so `request.url` here
      // deliberately points at an address the public `src` was never minted
      // against — only the `Host` header carries the real, public-facing
      // value. A route that read `new URL(request.url).host` instead of the
      // `Host` header would 400 this legitimate request.
      const { GET } = await importRoute();
      const src = 'https://wiki.example.com:4333/api/artifact/p1/r1?t=tok';
      const req = requestFor(`http://127.0.0.1:4331/_artifact-frame?src=${encodeURIComponent(src)}`, { host: 'wiki.example.com:4333' });

      const res = await GET(req);

      expect(res.status).toBe(200);
      expect(res.headers.get('Content-Security-Policy')).toBe(
        "default-src 'none'; frame-src wiki.example.com:4333; style-src 'unsafe-inline'; frame-ancestors 'self'",
      );
    });

    it('400s when the Host header is absent, even if request.url would otherwise match', async () => {
      const { GET } = await importRoute();
      const src = 'https://wiki.example.com/api/artifact/p1/r1?t=tok';
      const req = requestFor(`https://wiki.example.com/_artifact-frame?src=${encodeURIComponent(src)}`, { host: null });

      const res = await GET(req);

      expect(res.status).toBe(400);
    });
  });
});
