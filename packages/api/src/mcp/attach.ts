/**
 * RFC-0011 §7 — attach the built-in MCP server to the Hono app.
 *
 * `attachMcp(app, crowi)` registers `app.all('/mcp', …)` under
 * `createJwtAuth(crowi)` so the request carries an authenticated user +
 * `authScopes` (PAT or OAuth access token — no new auth code, RFC-0011
 * §5.1). Per-tool scope is NOT enforced here: each tool dispatches to a
 * scoped route that runs `requireScope` itself (RFC-0011 §5.2), so a
 * read-only token calling a write tool gets the route's 403 mapped to an
 * MCP `isError` result.
 *
 * Unlike `collab/attach.ts` / `notifications/attach.ts` (which attach a
 * WS upgrade handler to the `http.Server`), `/mcp` is a normal Hono
 * route, so this is called **inside `buildHonoApp`** (RFC-0011 §7).
 *
 * Transport: `@hono/mcp`'s `StreamableHTTPTransport`, **stateless /
 * per-request** (`sessionIdGenerator: undefined`) — matches Crowi's
 * per-request JWT model and needs no sticky sessions for multi-instance
 * deployments (RFC-0011 §4). A fresh `McpServer` + transport per request
 * binds that request's identity (the forwarded bearer).
 */
import type { OpenAPIHono } from '@hono/zod-openapi';
import { StreamableHTTPTransport } from '@hono/mcp';
import { HTTPException } from 'hono/http-exception';

import type Crowi from 'src/crowi';
import { createRateLimiter } from 'src/util/rate-limit';
import { resolveRedisKeyspaceIfEnabled } from 'src/util/redis-keyspace';

import type { CrowiHonoBindings } from '../hono/app';
import { createJwtAuth } from '../hono/middleware/auth';
import { makeDispatch } from './dispatch';
import { buildMcpServer } from './server';

/**
 * Per-user budget for the `/mcp` endpoint. A single budget covers all
 * tool calls (reads + writes); a runaway agent cannot hammer the wiki.
 * Note the dispatched routes that have their own limiter (autocomplete)
 * are double-counted — accepted for v1 (RFC-0011 open question).
 */
const RATE_LIMIT = 120;
const RATE_WINDOW_MS = 60_000;

/**
 * JSON-RPC error codes for the few responses we emit before the MCP
 * transport takes over (rate-limit / missing-bearer). `-32000` is the
 * JSON-RPC "server error" range; `-32001` distinguishes the auth case.
 */
const JSONRPC_RATE_LIMITED = -32000;
const JSONRPC_AUTH_REQUIRED = -32001;

/** A bare JSON-RPC error envelope (`id: null` — pre-dispatch, no request id). */
const jsonRpcError = (code: number, message: string) => ({ jsonrpc: '2.0' as const, error: { code, message }, id: null });

export const attachMcp = (app: OpenAPIHono<CrowiHonoBindings>, crowi: Crowi): void => {
  // One shared limiter per process (Redis-backed when `crowi.redis !==
  // null`, in-memory fallback otherwise — same pattern as autocomplete).
  const limiter = createRateLimiter({
    name: 'mcp',
    limit: RATE_LIMIT,
    windowMs: RATE_WINDOW_MS,
    redisClient: crowi.redis ?? null,
    keyspace: resolveRedisKeyspaceIfEnabled(crowi),
  });

  // Auth gate: a valid PAT / OAuth token is required to reach the
  // endpoint at all. Per-tool scope is enforced downstream.
  app.use('/mcp', createJwtAuth(crowi));

  // Rate limit AFTER jwtAuth so `c.get('user')` is populated. The 429 is
  // emitted as a JSON-RPC-ish error envelope (an MCP client speaks
  // JSON-RPC; a bare HTTP 429 with a `Retry-After` header is still
  // honoured by well-behaved clients, and the body is informational).
  app.use('/mcp', async (c, next) => {
    const user = c.get('user');
    // Defensive: jwtAuth always populates `user` before this runs.
    if (user) {
      const result = await limiter.hit(user._id.toString());
      if (!result.allowed) {
        c.header('Retry-After', String(result.retryAfterSeconds));
        return c.json(jsonRpcError(JSONRPC_RATE_LIMITED, `Rate limit exceeded. Retry after ${result.retryAfterSeconds}s.`), 429);
      }
    }
    await next();
    return;
  });

  // The MCP route itself: a fresh server + transport per request.
  app.all('/mcp', async (c) => {
    const authorization = c.req.header('authorization');
    if (!authorization) {
      // jwtAuth would have rejected a missing header already; this is a
      // type-narrowing guard (a cookie-authenticated request has no
      // header to forward, which the MCP transport does not support).
      return c.json(jsonRpcError(JSONRPC_AUTH_REQUIRED, 'MCP requires a Bearer Authorization header.'), 401);
    }

    const dispatch = makeDispatch(app, authorization);
    const server = buildMcpServer({ dispatch });

    const transport = new StreamableHTTPTransport({
      // Stateless: no session id, no long-lived session map.
      sessionIdGenerator: undefined,
      // DNS-rebinding protection is intentionally OFF. It is a defence for
      // unauthenticated / ambient-authority (browser) servers; `/mcp` is
      // Bearer-gated (a rebinding attacker cannot mint the user's PAT — the
      // custom Authorization header forces a CORS preflight) and is hit by
      // non-browser clients (Claude Code, the SDK), so Host pinning adds
      // nothing here. Browser cross-origin access is governed by `createCors`.
      // Pinning to a host (e.g. `CLIENT_URL`, the web origin) would instead
      // reject every legitimate client whenever the api runs on its own
      // host/port (dev's :4301 vs web :4302, or any split api/web deploy).
      enableDnsRebindingProtection: false,
    });

    await server.connect(transport);
    let response: Response | undefined;
    try {
      response = await transport.handleRequest(c);
    } catch (err) {
      // `@hono/mcp` signals protocol-level rejections (DNS-rebinding /
      // Accept-header / unsupported method) by throwing an `HTTPException`
      // that already carries a fully-formed JSON-RPC error response.
      // Crowi's global `onError` would flatten that into a generic 500, so
      // we return the exception's own response here to preserve the
      // correct status (403 / 406 / 405) and JSON-RPC body.
      if (err instanceof HTTPException) {
        return err.getResponse();
      }
      throw err;
    }
    // `handleRequest` returns `Response | undefined`; a defined Response
    // is always produced for POST/GET MCP traffic.
    return response ?? c.body(null, 204);
  });
};
