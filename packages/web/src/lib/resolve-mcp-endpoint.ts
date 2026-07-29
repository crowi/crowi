/**
 * Resolve the absolute URL of the built-in MCP server (RFC-0011) so the
 * settings UI can hand the user a copy-pasteable client config.
 *
 * The endpoint is the api's `/api/v2/mcp` route, but an MCP client lives
 * outside the browser and cannot resolve a relative URL — unlike
 * `apiV2BaseUrl()`, which stays relative in the same-origin deployment. So the
 * origin is filled in the same order the api client resolves it:
 *
 *   1. **`NEXT_PUBLIC_API_URL`** when set — cross-origin api (Vercel / split
 *      host), read at runtime via `apiOrigin()`.
 *   2. **`window.location.origin`** — the same-origin default, where the front
 *      proxy forwards `/api/v2/*` to the api (dev proxy and the distributed
 *      image alike).
 *   3. **{@link MCP_ENDPOINT_PLACEHOLDER}** during SSR / prerender, where there
 *      is no browser origin to read.
 */

import { apiOrigin } from './api-client';

/** Rendered until the browser origin is known (SSR / prerender). */
export const MCP_ENDPOINT_PLACEHOLDER = 'https://<crowi-host>/api/v2/mcp';

/** Absolute `<origin>/api/v2/mcp` URL, or the placeholder when unresolvable. */
export function resolveMcpEndpoint(): string {
  const origin = apiOrigin() || (typeof window !== 'undefined' ? window.location.origin : '');
  return origin ? `${origin}/api/v2/mcp` : MCP_ENDPOINT_PLACEHOLDER;
}
