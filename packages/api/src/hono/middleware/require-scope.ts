/**
 * RFC-0010 — `requireScope(scope)` route guard.
 *
 * Reads `authScopes` (set by `createJwtAuth`) and checks it against the
 * route's required scope via `scopeSatisfies` (which encodes write→read
 * and umbrella read/write implication). On failure it returns
 * `403 INSUFFICIENT_SCOPE` with a `WWW-Authenticate: Bearer
 * error="insufficient_scope"` header (RFC 6750 §3.1) so SDKs can detect a
 * scope shortfall without parsing the body.
 *
 * Web sessions authenticate with `authScopes = ALL_SCOPES`, so every
 * `requireScope` passes for them — the existing UI behaviour is
 * unchanged. Only OAuth tokens (Phase 1) / PATs (Phase 2) are ever
 * narrowed.
 *
 * MUST be installed AFTER `createJwtAuth(crowi)` so `authScopes` is
 * populated; a missing value indicates an apply-order bug at the
 * registration site and is surfaced as 401 (not 500) to keep the wire
 * predictable.
 */
import { type InsufficientScopeError, type Scope, scopeSatisfies } from '@crowi/api-contract';
import type { Hono } from 'hono';
import { createMiddleware } from 'hono/factory';

import type { CrowiHonoBindings } from '../app';
import { AUTH_REQUIRED_BODY } from './auth';

/**
 * A `@hono/zod-openapi` `createRoute(...)` definition exposes its HTTP
 * method and, via `getRoutingPath()`, the Hono routing path
 * (`/user/:username`) — as opposed to the OpenAPI `path` (`/user/{username}`).
 * We attach the scope guard to the exact `method + routing-path` pair (not the
 * whole prefix — `GET /pages` is read but `POST /pages` is write).
 */
type RouteLike = { method: string; getRoutingPath: () => string };

/**
 * Attach `requireScope(scope)` to a single `method + path` route on the
 * shared Hono chain. Registering as a method-scoped middleware (via
 * `app.on`) BEFORE the `.openapi(route, handler)` call means the guard
 * runs first and the handler only sees scope-satisfied requests.
 *
 * The path MUST come from `route.getRoutingPath()` (Hono form, `:param`),
 * not `route.path` (OpenAPI form, `{param}`). `.openapi()` registers the
 * handler on the routing path, so a guard registered on the literal
 * `{param}` path would never match a real request — silently skipping the
 * scope check on every parameterized route. Reusing the route object keeps
 * the mapping declarative and free of stringly-typed path drift.
 *
 * `app` is typed as the bare `Hono` to avoid extending the already-deep
 * `OpenAPIHono` chain (TS2589); the middleware itself is fully typed
 * against `CrowiHonoBindings`.
 */
export const applyScope = (app: Hono<CrowiHonoBindings>, route: RouteLike, scope: Scope): void => {
  app.on(route.method, route.getRoutingPath(), requireScope(scope));
};

export const requireScope = (scope: Scope) =>
  createMiddleware<CrowiHonoBindings>(async (c, next) => {
    const authScopes = c.get('authScopes');
    if (!authScopes) {
      return c.json(AUTH_REQUIRED_BODY, 401);
    }

    if (!scopeSatisfies(scope, authScopes)) {
      c.header('WWW-Authenticate', `Bearer error="insufficient_scope", scope="${scope}"`);
      const body: InsufficientScopeError = {
        error: {
          code: 'INSUFFICIENT_SCOPE',
          message: `This action requires the '${scope}' scope.`,
          details: { requiredScope: scope },
        },
      };
      return c.json(body, 403);
    }

    await next();
  });
