/**
 * RFC-0006 Phase 6 Sub-batch D — `/api` prefix stripper.
 *
 * The OpenAPI contracts in `@crowi/api-contract` register every route
 * at its un-prefixed path (`/app/info`, `/pages/:id`, ...) — keeping
 * the path literal short keeps each inferred chain type shallow, which
 * matters for the `CrowiApiClient` typed client (RFC-0006 Phase 4 hit
 * TS2589 on a deeper chain).
 *
 * Production traffic arrives as `/api/<path>`. Rather than re-mount
 * every route through `app.route('/api', child)` (which re-engages
 * the chain-depth problem — see the TS2589 note in
 * `packages/api-contract/src/client.ts`), we strip the prefix on the
 * boundary: the production listener in `crowi/index.ts:start()` and
 * the test request listener in `src/test/setup.ts` both pre-process
 * the inbound `Request` here.
 *
 * Paths that do not start with `/api` are returned unchanged — the
 * `/docs` + `/openapi.json` documentation routes inside Hono are
 * already at the root and we want them addressable at
 * `/api/docs` / `/api/openapi.json` once stripped. (See
 * `src/hono/index.ts` for those route registrations.)
 */
import type { Http2Bindings, HttpBindings } from '@hono/node-server';

const PREFIX = '/api';

/**
 * Return a new `Request` whose URL has the leading `/api` removed
 * (`/api/foo/bar` → `/foo/bar`, `/api` → `/`). All other
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
export function stripApiPrefix(request: Request): Request {
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

/**
 * Minimal surface of an `OpenAPIHono`/`Hono` app this module depends on —
 * narrow so a caller can pass either the real app or a purpose-built test
 * double without importing Hono's own (much larger) app type here.
 */
export interface HonoFetchTarget {
  fetch(request: Request, env?: HttpBindings | Http2Bindings): Response | Promise<Response>;
}

/**
 * RFC-0014 phase 1 §8 (AC-8) — the exact `(request, env) => honoApp.fetch(
 * stripApiPrefix(request), env)` call BOTH the production node-server
 * listener (`crowi/index.ts:start()`) and the shared supertest listener
 * (`src/test/setup.ts`) use, factored out to ONE place. `@hono/node-server`'s
 * `FetchCallback` is `(request, env) => ...` (2 args); `env` is `{ incoming,
 * outgoing }` (`node:http`'s `IncomingMessage`/`ServerResponse`), and
 * propagating it through to `honoApp.fetch` is what lets `getConnInfo(c)`
 * (`@hono/node-server/conninfo`) read `c.env.incoming`. Centralizing this
 * one-line call means a regression back to a 1-arg callback that silently
 * drops `env` breaks in exactly one place — and `crowi/index.test.ts`'s AC-8
 * test imports and calls this SAME function, not a hand-copied duplicate of
 * the wiring, so that regression fails the test too.
 */
export function dispatchToHonoApp(honoApp: HonoFetchTarget, request: Request, env: HttpBindings | Http2Bindings): Response | Promise<Response> {
  return honoApp.fetch(stripApiPrefix(request), env);
}
