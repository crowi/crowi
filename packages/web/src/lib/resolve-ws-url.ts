/**
 * Shared WebSocket base-URL resolver for the three realtime namespaces
 * (`/collab`, `/presence`, `/notifications`). All three attach to the same api
 * `http.Server`, so they derive from the same source and differ only in the
 * trailing path segment.
 *
 * The two `NEXT_PUBLIC_*` reads below resolve at **runtime** (`env()` reads the
 * `window.__ENV` map injected by the root layout) — one built image targets any
 * api origin, including cross-origin, via container env at start. Precedence:
 *
 *   1. **`NEXT_PUBLIC_COLLAB_URL`** explicit override wins when set — for
 *      operators who front collab on a distinct host (e.g.
 *      `wss://collab.example.com`) or who serve api on a separate origin
 *      (e.g. a Vercel frontend dialing the api's WS directly).
 *
 *   2. **`NEXT_PUBLIC_API_URL`** when set — cross-origin api, or dev/Vercel
 *      builds that bake the api URL.
 *
 *   3. **`window.location`** derivation — the default for both the dev
 *      launcher's single-origin proxy (`pnpm dev`, feature-dev-portal-worktree
 *      §4) and the distributed same-origin `crowi/crowi-web` image, where no
 *      API URL is baked in. In dev, `pnpm dev` fronts api+web+the three WS
 *      namespaces behind one Caddy (or zero-dep fallback) proxy on
 *      `anchor+3`, routing by path exactly like the prod front proxy
 *      (`Caddyfile`) — so the browser dialing its own origin reaches the api
 *      the same way in dev and in prod, and it's what makes realtime editing
 *      reachable from an iPhone over tailscale (Next's `rewrites()` is
 *      HTTP-only and can't forward a WS `upgrade`, so there is no way to make
 *      this work without a same-origin proxy in front of both). This means
 *      the canonical dev entry point is the proxy origin (`anchor+3`), not the
 *      raw web port (`anchor+1`) — opening the web port directly skips the
 *      proxy and collab/presence/notifications won't connect.
 *
 *   4. **`http://localhost:4301`** SSR / last-resort fallback — `window` is
 *      undefined during SSR, and nothing else was configured. (This is the
 *      main worktree's default api anchor; harmless as a fallback since a WS
 *      client is never constructed during SSR.)
 *
 * The resolved base is normalised so the appended namespace never produces a
 * double slash or a doubled namespace segment:
 *   - any trailing slash is stripped (`http://api/` → `http://api`)
 *   - a `/collab`, `/presence` or `/notifications` suffix (with or without a
 *     trailing slash) is stripped so an operator can point a single override
 *     env at all three namespaces without producing
 *     `/notifications/notifications` etc.
 *   - `http(s)://` is rewritten to `ws(s)://`.
 */

import { env } from './runtime-env';

const NAMESPACE_SUFFIX_RE = /\/(collab|presence|notifications)\/?$/;

/**
 * The raw (still `http(s)://`) base URL the WebSocket namespaces share. Always
 * resolves to a string: an explicit override / baked api URL, the browser
 * origin (same-origin image path), or the SSR `localhost` fallback.
 */
function resolveWsBase(): string {
  // Read at call time (see runtime-env) so the synchronously-injected
  // `window.__ENV` drives the value — a single built image can target a
  // cross-origin api by setting these on the container at start, no rebuild.
  const override = env('NEXT_PUBLIC_COLLAB_URL');
  if (override) return override;

  const apiUrl = env('NEXT_PUBLIC_API_URL');
  if (apiUrl) return apiUrl;

  // Same-origin default (dev's proxy AND the distributed prod image): no
  // baked URL, derive from the browser origin. The outer reverse proxy
  // (Caddy — either the dev launcher's per-worktree proxy or the prod front
  // proxy) routes the WS upgrade to the api.
  if (typeof window !== 'undefined') {
    return `${window.location.protocol}//${window.location.host}`;
  }

  // SSR / last resort.
  return 'http://localhost:4301';
}

/**
 * Resolve a `ws[s]://<host>/<namespace>` base URL for the given realtime
 * namespace. See the module doc for the resolution order and normalisation.
 */
export function resolveWsUrl(namespace: 'collab' | 'presence' | 'notifications'): string {
  const raw = resolveWsBase();
  const base = raw.replace(NAMESPACE_SUFFIX_RE, '').replace(/\/$/, '');
  return `${base.replace(/^http/, 'ws')}/${namespace}`;
}
