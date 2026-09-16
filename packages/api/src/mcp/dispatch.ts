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
  /**
   * Extra headers a tool wants to send (RFC-0020 §M-1, e.g.
   * `X-Crowi-Page-Content-Type`). `authorization` / `content-type` are
   * stripped here (case-insensitively) before the caller's own `Authorization`
   * and `content-type` are applied, so a tool can never override the
   * dispatcher's own identity or body framing — see `makeDispatch` below.
   */
  headers?: Record<string, string>;
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
 * Fetch's `Headers` treats names case-insensitively and CONCATENATES a
 * repeated name rather than overwriting it, so a caller-supplied
 * `authorization` (lowercase) would corrupt the real `Authorization` this
 * dispatcher sets rather than simply losing a shadowing race. Normalising
 * every surviving key to lowercase here (and applying `Authorization` /
 * `content-type` afterwards, in `makeDispatch`) is what makes "the caller
 * can never override these two" true regardless of the case a tool used.
 */
const stripAuthAndContentType = (headers: Record<string, string> | undefined): Record<string, string> => {
  if (!headers) return {};
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    const lower = key.toLowerCase();
    if (lower === 'authorization' || lower === 'content-type') continue;
    result[lower] = value;
  }
  return result;
};

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
        ...stripAuthAndContentType(init?.headers),
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
