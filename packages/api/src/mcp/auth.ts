/**
 * feature-auth-cookie-fallback-scope — `/mcp`-only auth boundary: PAT
 * Bearer credentials exclusively.
 *
 * Does NOT wrap `createJwtAuth` (design decision 4 in the spec) — it calls
 * `resolveCredential` directly with `{ cookieEligible: false,
 * headerTokenKinds: {'pat'} }` so a web-session Bearer, the
 * `crowi.accessToken` cookie, and an (unbound, RFC-0022 out of scope for
 * now) `oauth_access` token are all rejected at this single boundary —
 * before any cookie read or DB lookup differs from the PAT path. RFC-0022
 * §6.2/§7 scopes `/mcp` to PAT or a canonical-MCP-resource-bound
 * `oauth_access`; `signOauthAccessToken` does not yet mint a resource/
 * audience claim, so this spec rejects `oauth_access` outright until that
 * binding lands (out of scope here).
 *
 * A `resolveCredential` failure is mapped differently from every other
 * boundary: a `401` (credential unresolved) is wrapped in a JSON-RPC error
 * envelope, because the `@hono/mcp` transport hasn't taken over yet at this
 * point — a bare Hono 401 body would not be a valid JSON-RPC response. A
 * `403` (`UserStatusError` — suspended / registered / invited account) is
 * passed through unchanged, matching every other Crowi API boundary. An
 * infrastructure throw (`User.findById`, PAT `touchLastUsed()`, …) is not
 * caught here — it propagates to the app's `onError` (500), same posture as
 * `createJwtAuth`.
 */
import { createMiddleware } from 'hono/factory';

import type Crowi from 'src/crowi';

import { createAuthDeps, type HeaderTokenKind, type HonoAuthVariables, resolveCredential } from '../hono/middleware/auth';

/**
 * JSON-RPC "server error" code for the auth-required case. Mirrors
 * `mcp/attach.ts`'s own `JSONRPC_AUTH_REQUIRED` (`-32001`) — kept as a
 * separate local constant (not imported) to avoid an `mcp/auth.ts` <->
 * `mcp/attach.ts` import cycle: `attach.ts` wires this middleware onto
 * `/mcp`, so it must import from here, not the other way around.
 */
const JSONRPC_AUTH_REQUIRED = -32001;

/** A bare JSON-RPC error envelope (`id: null` — pre-dispatch, no request id). Wire-format identical to `mcp/attach.ts`'s own helper. */
const jsonRpcError = (code: number, message: string) => ({ jsonrpc: '2.0' as const, error: { code, message }, id: null });

const MCP_HEADER_TOKEN_KINDS: ReadonlySet<HeaderTokenKind> = new Set(['pat']);

export const createMcpAuth = (crowi: Crowi) => {
  const deps = createAuthDeps(crowi);

  return createMiddleware<{ Variables: HonoAuthVariables }>(async (c, next) => {
    const result = await resolveCredential(c, deps, { cookieEligible: false, headerTokenKinds: MCP_HEADER_TOKEN_KINDS });
    if (!result.ok) {
      if (result.status === 401) {
        return c.json(jsonRpcError(JSONRPC_AUTH_REQUIRED, 'MCP requires a valid Personal Access Token.'), 401);
      }
      // 403 (UserStatusError) — passed through unchanged, not wrapped in a
      // JSON-RPC envelope. Every non-MCP boundary does the same for a
      // suspended/registered/invited account; MCP only special-cases 401.
      return c.json(result.body, 403);
    }
    await next();
  });
};
