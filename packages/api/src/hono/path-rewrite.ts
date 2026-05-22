/**
 * RFC-0006 Phase 6 Sub-batch D — `/api/v2` prefix stripper.
 *
 * The OpenAPI contracts in `@crowi/api-contract` register every route
 * at its un-prefixed path (`/app/info`, `/pages/:id`, ...) — keeping
 * the path literal short keeps the inferred `AppType` chain shallow,
 * which matters for the `hc<AppType>` client (RFC-0006 Phase 4 hit
 * TS2589 on a deeper chain).
 *
 * Production traffic arrives as `/api/v2/<path>`. Rather than re-mount
 * every route through `app.route('/api/v2', child)` (which re-engages
 * the AppType chain — see the TS2589 note in
 * `packages/api-contract/src/client.ts`), we strip the prefix on the
 * boundary: the production listener in `crowi/index.ts:start()` and
 * the test request listener in `src/test/setup.ts` both pre-process
 * the inbound `Request` here.
 *
 * Paths that do not start with `/api/v2` are returned unchanged — the
 * `/docs` + `/openapi.json` documentation routes inside Hono are
 * already at the root and we want them addressable at
 * `/api/v2/docs` / `/api/v2/openapi.json` once stripped. (See
 * `src/hono/index.ts` for those route registrations.)
 */
const PREFIX = '/api/v2';

/**
 * Return a new `Request` whose URL has the leading `/api/v2` removed
 * (`/api/v2/foo/bar` → `/foo/bar`, `/api/v2` → `/`). All other
 * properties (method / headers / body / signal) are preserved by
 * re-using the original `Request` object as the second argument to
 * the `Request` constructor.
 *
 * Requests that do not start with the prefix are returned unchanged.
 *
 * `duplex: 'half'` is passed alongside so the undici-backed `Request`
 * constructor accepts a streaming body (Node 20+ rejects a Request
 * with a stream body unless `duplex` is set). It's a no-op for
 * GET/HEAD or already-buffered bodies.
 */
export function stripApiV2Prefix(request: Request): Request {
  const url = new URL(request.url);
  if (url.pathname === PREFIX) {
    url.pathname = '/';
  } else if (url.pathname.startsWith(`${PREFIX}/`)) {
    url.pathname = url.pathname.slice(PREFIX.length);
  } else {
    return request;
  }
  // Re-use the original Request as the init; the constructor copies
  // method / headers / body / signal. Passing a Request as init avoids
  // having to set `duplex: 'half'` manually for stream bodies — the
  // platform inherits the duplex hint from the source Request.
  return new Request(url.toString(), request);
}
