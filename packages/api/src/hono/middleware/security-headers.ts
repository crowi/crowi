import type { MiddlewareHandler } from 'hono';

/**
 * Response hardening headers applied to every route.
 *
 * Currently just `X-Content-Type-Options: nosniff`. It matters most for the
 * attachment delivery routes (`handlers/attachment-stream.ts`), which stream
 * user-uploaded bytes back from the same origin the wiki is served from on the
 * recommended topology (`packages/web/next.config.ts` rewrites `/api/v2/*` onto
 * the web origin). Without `nosniff` a browser may disregard the declared
 * `Content-Type` and sniff the body as HTML, which would re-open the
 * origin-executing payload path that `buildDeliveryHeaders` closes by pinning
 * the type — the two defences are deliberately paired, and this one is applied
 * app-wide rather than on the attachment routes alone because sniffing is never
 * wanted on any response this API produces.
 *
 * A `Content-Security-Policy` is deliberately NOT set here: the editor's
 * `renderMdast` path intentionally allows dangerous HTML (`iframe` / `script` /
 * `style` / `foreignObject` are in its known-tags list), so a CSP needs its own
 * design pass rather than riding along with this middleware.
 */
export const createSecurityHeaders = (): MiddlewareHandler => async (c, next) => {
  await next();
  // Set on `c.res.headers` after the handler has produced its response —
  // the streaming attachment routes return a `new Response(...)` of their
  // own, which replaces anything staged with `c.header()` beforehand.
  c.res.headers.set('X-Content-Type-Options', 'nosniff');
};
