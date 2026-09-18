/**
 * The intermediate document that lets a wiki page embed an HTML artifact
 * without giving the wiki page's own document a
 * `Content-Security-Policy`. `renderMdast`'s known-tags list intentionally
 * allows raw `<iframe>` in page bodies (see
 * `packages/web/src/components/editor/known-tags.ts` and the CSP note in
 * `packages/api/src/hono/middleware/security-headers.ts`), so a CSP on the
 * wiki page's own document would blank out every existing embed, not just
 * the artifact's. Instead, `ArtifactView` points its (unsandboxed, same-
 * origin) outer iframe at THIS route, and only this route's response
 * carries `frame-src` — which is evaluated against the requesting frame's
 * OWN parent, so it constrains the artifact's self-navigation without
 * touching the wiki page's CSP at all.
 *
 * Directory name is the literal string `%5Fartifact-frame` (percent-encoded
 * `_`) rather than `_artifact-frame` — Next.js treats a `_`-prefixed app
 * directory as a private folder excluded from routing, and `%5F` is the
 * existing repo convention for a route that must actually live at `/_...`
 * (see `(auth)/%5Fedit`, `%5Fhistory`). `/_*` is reserved page-name
 * namespace (`Page.isCreatableName`), so a wiki page can never collide with
 * this path.
 *
 * Public, unauthenticated: this document returns nothing secret of its own
 * — the only thing gating the artifact bytes is the signed token already
 * embedded in `src`, verified downstream by the delivery route.
 */
import { readPublicRuntimeEnv } from '@/lib/public-runtime-env';
import { escapeHtml } from '@/lib/sanitise-snippet';

// This route's whole purpose is to validate a per-request `src` query
// param against the current request's own origin/host — a cached or
// statically-generated response would validate against a stale one.
export const dynamic = 'force-dynamic';

/**
 * Sandbox applied to the INNER iframe this document renders (the one whose
 * `src` is the artifact's signed delivery URL). Deliberately just
 * `allow-scripts` — no `allow-same-origin` (would let the artifact remove
 * its own sandbox), `allow-top-navigation`, `allow-forms`, or `allow-popups`.
 * `ArtifactView`'s OUTER iframe (pointed at this route) must NOT carry this
 * attribute: sandboxing it would make this same-origin document opaque-
 * origin, which no longer matches the artifact response's
 * `frame-ancestors <crowi origin>` and the frame fails to load.
 */
export const ARTIFACT_IFRAME_SANDBOX = 'allow-scripts';

/**
 * The exact CSP this document serves. `frameSrc` is either a full origin
 * (scheme+host[:port], when `NEXT_PUBLIC_ARTIFACT_ORIGIN` is configured) or
 * a scheme-less `host[:port]` (same-origin delivery — see
 * `resolveArtifactOrigin`, a browser matches a scheme-less CSP host-source
 * against the embedding document's own scheme, which sidesteps having to
 * trust a possibly-unterminated-TLS request's apparent scheme). `'self'` is
 * deliberately never added: allowing it would let the artifact navigate its
 * own frame back into the Crowi origin, defeating the reason this CSP
 * exists.
 */
export const ARTIFACT_FRAME_CSP = (frameSrc: string): string => `default-src 'none'; frame-src ${frameSrc}; style-src 'unsafe-inline'; frame-ancestors 'self'`;

type ResolvedArtifactOrigin = Readonly<{ mode: 'configured'; origin: string }> | Readonly<{ mode: 'request-host'; host: string | null }>;

/**
 * `NEXT_PUBLIC_ARTIFACT_ORIGIN` is read via `readPublicRuntimeEnv()` (an
 * indexed lookup into `process.env`, not a literal `process.env.NEXT_PUBLIC_*`
 * member access) so this evaluates at REQUEST time, not baked in at build
 * time — the same reasoning `public-runtime-env.ts` documents for the
 * browser-injected `window.__ENV` path. When unset (same-origin delivery),
 * falls back to the CURRENT request's own host, read from the `Host`
 * header rather than `request.url` — Next's router rebuilds `request.url`
 * from its own `hostname:port` bind address whenever
 * `experimental.trustHostHeader` is off (the default, unset here), so
 * behind a reverse proxy `request.url` carries the server's internal port,
 * never the public one the browser actually connected to and the signed
 * `src` was minted against. The `Host` header is untouched by that
 * rewriting: it comes straight from the incoming request. Deliberately NOT
 * matched on scheme either: behind a TLS-terminating proxy this server sees
 * `http`, while the signed artifact URL a same-origin mint produces is
 * built from `CLIENT_URL` and is `https`. Comparing on host+port only
 * (never scheme) avoids rejecting every legitimate same-origin request in
 * that (common) topology; the real defence against a scheme downgrade is
 * this response's own scheme-less `frame-src` token, which the browser
 * resolves against the page's real (TLS-terminated) scheme.
 */
function resolveArtifactOrigin(request: Request): ResolvedArtifactOrigin {
  const configured = readPublicRuntimeEnv().NEXT_PUBLIC_ARTIFACT_ORIGIN;
  if (configured) {
    return { mode: 'configured', origin: new URL(configured).origin };
  }
  return { mode: 'request-host', host: request.headers.get('host') };
}

type ValidatedSrc = Readonly<{ url: URL; frameSrcToken: string }>;

/**
 * `src` must be present, parseable, and resolve to exactly the artifact
 * origin this deployment expects — otherwise this document would be a
 * generic same-origin iframe-anything gadget. Matching is exact (scheme +
 * host + port) when an artifact origin is configured, host + port only
 * (see `resolveArtifactOrigin` above) otherwise; this check is
 * intentionally NOT stricter than the CSP it precedes (never scheme-checked
 * in the unconfigured case) — the CSP is the outer, browser-enforced
 * defence, this is only the inner one deciding whether to serve a frame at
 * all. Returns the CSP `frame-src` token alongside the validated URL so the
 * caller never has to re-derive it (and can't drift from what was actually
 * matched against).
 */
function validateSrc(rawSrc: string | null, resolved: ResolvedArtifactOrigin): ValidatedSrc | null {
  if (!rawSrc) return null;
  let parsed: URL;
  try {
    parsed = new URL(rawSrc);
  } catch {
    return null;
  }
  if (resolved.mode === 'configured') {
    return parsed.origin === resolved.origin ? { url: parsed, frameSrcToken: resolved.origin } : null;
  }
  if (resolved.host === null) return null;
  return parsed.host === resolved.host ? { url: parsed, frameSrcToken: resolved.host } : null;
}

export async function GET(request: Request): Promise<Response> {
  const resolved = resolveArtifactOrigin(request);
  const rawSrc = new URL(request.url).searchParams.get('src');
  const validated = validateSrc(rawSrc, resolved);
  if (!validated) {
    // Plain text, not HTML — an invalid `src` must never produce a
    // document this route's own CSP would otherwise vouch for.
    return new Response('Invalid or missing src.', { status: 400, headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
  }

  // No inline script anywhere in this document — the only reason it needs
  // a CSP at all is to constrain the CHILD frame, so the document itself
  // stays trivial enough that `default-src 'none'` never has to be relaxed.
  const html = `<!doctype html><html><head><meta charset="utf-8"><style>html,body{margin:0;padding:0;height:100%}iframe{display:block;width:100%;height:100%;border:0}</style></head><body><iframe src="${escapeHtml(validated.url.href)}" sandbox="${ARTIFACT_IFRAME_SANDBOX}" referrerpolicy="no-referrer"></iframe></body></html>`;

  return new Response(html, {
    status: 200,
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Content-Security-Policy': ARTIFACT_FRAME_CSP(validated.frameSrcToken),
    },
  });
}
