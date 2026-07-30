/**
 * RFC-0011 — in-process dispatch helper for the MCP tools.
 *
 * Each MCP tool reuses the existing API by dispatching **in-process** to
 * the same Hono routes the HTTP server serves, so validation, scope
 * enforcement, and business logic stay single-source-of-truth. The MCP
 * layer is a thin protocol translator — see RFC-0011 §3.1.
 *
 * Two boundary facts make this safe and simple:
 *  - Routes are registered on the Hono app at **root** (`/pages`,
 *    `/search`, …). The `/api` prefix is a boundary concern stripped
 *    by `stripApiPrefix` before `honoApp.fetch` (`hono/path-rewrite.ts`,
 *    `crowi/index.ts`). So internal dispatch uses the **bare** route path
 *    (`/pages`), never `/api/pages`.
 *  - We forward the caller's `Authorization` header verbatim, so the
 *    dispatched route re-runs `createJwtAuth` + `requireScope` for the
 *    same principal (RFC-0011 §10.4 "forward-the-header"; the optional
 *    fast-path that injects the resolved context is deferred).
 *
 * Non-2xx responses are surfaced as a typed `ApiToolError(status, body)`
 * so the tool layer can map them to an MCP `isError` result that carries
 * the API error envelope's `error.code` / `error.message` (RFC-0011 §9).
 */
import type { OpenAPIHono } from '@hono/zod-openapi';

import type { CrowiHonoBindings } from '../hono/app';

/**
 * Thrown by `dispatch` when the in-process route returns a non-2xx
 * status. Carries the parsed JSON body (the API error envelope) so the
 * tool layer can extract `error.code` / `error.message`.
 */
export class ApiToolError extends Error {
  constructor(
    public readonly status: number,
    public readonly body: unknown,
  ) {
    super(`MCP dispatch failed with status ${status}`);
    this.name = 'ApiToolError';
  }
}

/**
 * A query value bag. Values are coerced to strings; `undefined` entries
 * are dropped so optional contract fields (which Zod fills with defaults
 * server-side) don't serialise as the literal string `"undefined"`.
 */
export type DispatchQuery = Record<string, string | number | boolean | undefined | null>;

export interface DispatchInit {
  /** Query parameters for GET dispatches. */
  query?: DispatchQuery;
  /** JSON body for POST / PUT / DELETE dispatches. */
  json?: unknown;
}

/** Serialise a query bag, skipping `undefined` / `null`. */
const buildQueryString = (query: DispatchQuery): string => {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === null) continue;
    params.set(key, String(value));
  }
  const qs = params.toString();
  return qs ? `?${qs}` : '';
};

export type Dispatch = (method: string, path: string, init?: DispatchInit) => Promise<unknown>;

/**
 * Build a dispatcher bound to a single request's authorization. The
 * `honoApp` is captured at attach time (the same app `buildHonoApp`
 * builds); `authorization` is the caller's verbatim `Authorization`
 * header so the dispatched route authenticates as the MCP caller.
 *
 * The host is irrelevant for in-process dispatch (no socket is opened),
 * but `honoApp.request` needs an absolute-or-rooted URL; a rooted path
 * is what we pass, matching the test harness (`hono/path-rewrite.ts`).
 */
export const makeDispatch = (honoApp: OpenAPIHono<CrowiHonoBindings>, authorization: string): Dispatch => {
  return async (method, path, init) => {
    const url = `${path}${init?.query ? buildQueryString(init.query) : ''}`;

    const hasJsonBody = init?.json !== undefined;
    const res = await honoApp.request(url, {
      method,
      headers: {
        Authorization: authorization,
        ...(hasJsonBody ? { 'content-type': 'application/json' } : {}),
      },
      body: hasJsonBody ? JSON.stringify(init?.json) : undefined,
    });

    // Every Crowi API route replies JSON (success envelopes + error
    // envelopes). A non-JSON body would be an unexpected 5xx; parse
    // defensively so a malformed body still surfaces as an ApiToolError.
    let body: unknown;
    try {
      body = await res.json();
    } catch {
      body = { error: { code: 'INTERNAL_ERROR', message: `Non-JSON response (status ${res.status})` } };
    }

    if (!res.ok) {
      throw new ApiToolError(res.status, body);
    }
    return body;
  };
};
