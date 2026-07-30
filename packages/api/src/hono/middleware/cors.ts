/**
 * RFC-0006 Phase 6 Sub-batch C — Hono port of the Express `cors`
 * middleware. The Express bridge will be retired in Sub-batch D, after
 * which this is the only CORS layer on `/api/*` (and on every other
 * Hono-owned path, since Hono will then be the sole HTTP host).
 *
 * Allow-origin policy (mirrors `packages/api/src/crowi/express-init.ts`
 * byte-for-byte, with the same precedence order):
 *
 *   1. Requests with no `Origin` header are allowed (mobile clients,
 *      curl, server-to-server, supertest).
 *   2. `process.env.CLIENT_URL` exact match (production allow-list).
 *   3. In `NODE_ENV === 'development'`, any `localhost` / `127.0.0.1`
 *      origin (port-agnostic) is allowed — this is what lets the
 *      Next.js dev server on `:4302` talk to the api on `:4301`.
 *   4. `crowi.getBaseUrl()` exact match (covers deployments that
 *      reverse-proxy the api on its own hostname without setting
 *      `CLIENT_URL`).
 *   5. Anything else is rejected (returns `undefined` from the
 *      callback → Hono omits `Access-Control-Allow-Origin`, which
 *      makes the browser fail the CORS check).
 *
 * `credentials: true` is required for the JWT refresh-token cookie
 * (`crowi.accessToken`) used by `<img src=...>` style requests. The
 * `allowMethods` / `allowHeaders` lists match the Express config so
 * the wire-format diff is zero.
 */
import Debug from 'debug';
import { cors } from 'hono/cors';
import type { MiddlewareHandler } from 'hono';

import type Crowi from 'src/crowi';

const debug = Debug('crowi:hono:middleware:cors');

/**
 * Return value matches the Hono `cors` `origin` callback contract:
 * `string` — echo this exact origin back as
 * `Access-Control-Allow-Origin`; `undefined` / `null` — reject (no
 * header emitted).
 */
const buildOriginResolver = (crowi: Crowi) => {
  const env = crowi.node_env;
  const clientUrl = process.env.CLIENT_URL;

  return (origin: string): string | undefined => {
    // No `Origin` header (or empty string from the helper) — non-browser
    // clients. The Express cors package would call `callback(null,
    // true)`; the Hono equivalent is to echo back whatever the helper
    // produced (treat as same-origin). Hono normalises an absent
    // header to `''` here, so we cannot distinguish "no Origin" from
    // "empty Origin" — both fall through this branch, which matches
    // the legacy behaviour.
    if (!origin) return origin;

    if (clientUrl && origin === clientUrl) {
      return origin;
    }

    if (env === 'development' && (origin.includes('localhost') || origin.includes('127.0.0.1'))) {
      return origin;
    }

    const baseUrl = crowi.getBaseUrl();
    if (baseUrl && origin === baseUrl) {
      return origin;
    }

    if (env !== 'development') {
      debug('CORS rejected origin:', origin);
      return undefined;
    }

    // Dev fallback: allow anything in development so local plugin /
    // smoke-test traffic isn't blocked. Production rejected above.
    return origin;
  };
};

export const createCors = (crowi: Crowi): MiddlewareHandler => {
  const resolveOrigin = buildOriginResolver(crowi);
  debug('CORS enabled, CLIENT_URL:', process.env.CLIENT_URL || '(not set)');

  return cors({
    origin: (origin) => resolveOrigin(origin),
    credentials: true,
    allowMethods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    // `X-Crowi-Ast-Version` (RFC-0023 §9): today only the iOS native
    // app (not CORS-constrained) sends it, but allow-listing it now
    // keeps future browser-based debug/admin callers from silently
    // failing preflight.
    allowHeaders: ['Content-Type', 'Authorization', 'X-Requested-With', 'X-Crowi-Ast-Version'],
  });
};
