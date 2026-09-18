/**
 * RFC-0025 §9 Phase 2 — Hono request-scope boundary.
 *
 * Consumes the structured logging core (`src/util/logger.ts`,
 * `src/util/request-scope.ts`) to correlate every dispatch this app
 * completes with the canonical `X-Request-Id` Hono's own `requestId()`
 * middleware (installed right before this one, `hono/index.ts`, by
 * importing `requestId` from `hono/request-id` directly) already
 * validated or generated. `packages/api/src/hono/app.ts` is not touched —
 * importing `requestId` from `hono/request-id` augments Hono's global
 * `ContextVariableMap` with `RequestIdVariables`, so `c.get('requestId')`
 * is already typed everywhere in this program without a
 * `CrowiHonoBindings` edit.
 *
 * This module's new TypeScript surface is spec-fixed to exactly
 * `REQUEST_ID_HEADER` / `deriveRouteTemplate` / `createRequestScope` — no
 * 4th export. Every call site (production and every test harness) that
 * needs Hono's own `requestId()` imports it from `hono/request-id` and
 * calls `requestId({ headerName: REQUEST_ID_HEADER, limitLength: 128 })`
 * inline, restating the same two options rather than centralizing them
 * behind a helper here. Do not "reuse" that restatement back into a
 * shared factory in this file — the export surface is spec-fixed and a
 * 4th export is out of scope.
 */
import type { Context, MiddlewareHandler } from 'hono';
import { matchedRoutes } from 'hono/route';

import { createLogger } from 'src/util/logger';
import { runWithRequestScope } from 'src/util/request-scope';

export const REQUEST_ID_HEADER = 'X-Request-Id';

const UNMATCHED_ROUTE = '<unmatched>';
const PREFLIGHT_ROUTE = '<preflight>';

const logger = createLogger('crowi:hono:request');

/**
 * The single normative route-template derivation rule. No other module
 * may restate this differently.
 *
 * 1. A finalized CORS preflight (`OPTIONS` + final status 204) is reported
 *    as `<preflight>` without reading `matchedRoutes(c)`.
 * 2. Otherwise scan `matchedRoutes(c)` from last to first for the first
 *    entry whose `method` equals the request method and whose `path` does
 *    not end with `*`. This selects the concrete handler over an OpenAPI
 *    validator's duplicate entry at the same path/method.
 * 3. Otherwise scan again, method-agnostic, for the first entry whose
 *    `path` does not end with `*`. This resolves `.all('/mcp')` (no
 *    concrete method) and a `HEAD` request Hono dispatches against a
 *    matching `GET` route while keeping the original `HEAD` method on
 *    `c.req` (`hono-base.js`'s recursive `HEAD` handling) — step 2 never
 *    matches a `HEAD` request, so it must fall through to this step.
 * 4. Otherwise `<unmatched>`.
 *
 * A known residual: an exact-path `app.use('/search', …)` mount registers
 * as `ALL /search` with no trailing `*`, so a method-mismatch 404 (e.g.
 * `DELETE /search`) falls through to step 3 and reports `/search` instead
 * of `<unmatched>`. The value still comes from the route table, never from
 * client input, and the record's `method`/`status` disambiguate it — a
 * hardcoded list of `.all()`/`.use()` paths would be fragile against the
 * next route registered, so this is recorded rather than special-cased.
 *
 * Deliberately unused as inputs: raw pathname, decoded URL, query,
 * `routePath(c)`, `c.req.routeIndex`, method inequality, handler arity,
 * dispatch index, a hardcoded path list, `basePath`.
 */
export const deriveRouteTemplate = (c: Context): string => {
  if (c.finalized === true && c.req.method === 'OPTIONS' && c.res.status === 204) {
    return PREFLIGHT_ROUTE;
  }

  const routes = matchedRoutes(c);

  for (let i = routes.length - 1; i >= 0; i -= 1) {
    const route = routes[i];
    if (route.method === c.req.method && !route.path.endsWith('*')) {
      return route.path;
    }
  }

  for (let i = routes.length - 1; i >= 0; i -= 1) {
    const route = routes[i];
    if (!route.path.endsWith('*')) {
      return route.path;
    }
  }

  return UNMATCHED_ROUTE;
};

/**
 * Global request-scope middleware. Installed once, app-wide, right after
 * Hono's own `requestId()` (`hono/index.ts`).
 *
 * Runs the rest of the dispatch — security headers, CORS, AST negotiation,
 * plugin/route/MCP registration, not-found, `honoOnError` — inside one
 * `AsyncLocalStorage.run()` continuation (`runWithRequestScope`), so every
 * module-logger record produced downstream carries the same request ID.
 *
 * Resolves to `undefined` on every normal-return path (never the resolved
 * value of `next()` or the ALS callback) and rethrows every exceptional
 * path unchanged. `honoOnError` already turns a handler `Error` into a
 * generic 500 response before `await next()` resolves here, so the only
 * throw this middleware's `catch` ever observes is a non-`Error` value
 * that escaped Hono's own compose — a correlated diagnostic is recorded
 * for that case and the original value is rethrown by identity, never
 * wrapped or replaced.
 */
export const createRequestScope = (): MiddlewareHandler => {
  return async (c, next) => {
    const requestId = c.get('requestId');
    const startedAt = performance.now();

    await runWithRequestScope({ requestId }, async () => {
      try {
        await next();
      } catch (thrown) {
        if (!(thrown instanceof Error)) {
          logger.error('non-Error value escaped Hono dispatch', thrown, { outcome: 'non-error-throw-rethrown' });
        }
        throw thrown;
      }

      const method = c.req.method;

      if (!c.finalized) {
        // Reading `c.res` here would ALLOCATE an empty 200 Response
        // (`context.js`'s `res` getter) moments before Hono itself throws
        // "Context is not finalized" for the same dispatch — recording a
        // response the client never received. Route derivation is safe
        // (it does not read `c.res` on this branch); the header and a
        // response-start record are not.
        const route = deriveRouteTemplate(c);
        logger.warn('dispatch returned no response', { method, route });
        return;
      }

      // Hono's `requestId()` already staged this header before `next()`;
      // this second application survives a handler-constructed raw
      // `Response` that replaced whatever `c.header()` had staged
      // beforehand (`packages/api/src/hono/handlers/attachment-stream.ts`).
      c.header(REQUEST_ID_HEADER, requestId);
      const route = deriveRouteTemplate(c);
      const durationMs = Math.max(0, performance.now() - startedAt);
      logger.info('response started', { method, route, status: c.res.status, durationMs });
    });
  };
};
