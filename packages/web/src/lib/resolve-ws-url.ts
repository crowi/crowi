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
 *   3. **dev (`NODE_ENV==='development'`) → api dev port on the browser's host**
 *      (`<protocol>//<hostname>:4301`, or `http://localhost:4301` during SSR) —
 *      in `pnpm dev` the web app is on :4302 and the api (with the WS endpoints)
 *      on :4301: two different origins, and the Next dev server cannot proxy the
 *      WS `upgrade`. So dev must dial the api port directly (keeping the same
 *      host so LAN / Tailscale dev still reaches the dev machine) and must NOT
 *      fall through to `window.location` (:4302, no WS server there). NODE_ENV
 *      is build-inlined, so this branch is compiled out of production bundles.
 *
 *   4. **`window.location`** derivation — the default for the distributed
 *      same-origin `crowi/crowi-web` image, where no API URL is baked in. The
 *      browser dials its own origin (`ws[s]://<host>`) and the outer reverse
 *      proxy routes `/collab|/presence|/notifications` WS upgrades to the api.
 *
 *   5. **`http://localhost:4301`** SSR / last-resort fallback — `window` is
 *      undefined during SSR, and nothing else was configured.
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

  // Dev (`pnpm dev`): web is on :4302, api (with the WS endpoints) on :4301 —
  // different origins, and the Next dev server cannot proxy the WS upgrade. So
  // dial the api port (:4301) on the SAME host the browser used, so LAN /
  // Tailscale / remote dev (allowedDevOrigins) reaches the dev machine's api,
  // not the viewer's own localhost. Falling through to `window.location`
  // (:4302) would target a port with no WS server. NODE_ENV is build-inlined,
  // so this is compiled out of production bundles. (For an api on a different
  // host, set NEXT_PUBLIC_API_URL / NEXT_PUBLIC_COLLAB_URL.)
  if (process.env.NODE_ENV === 'development') {
    if (typeof window !== 'undefined') {
      return `${window.location.protocol}//${window.location.hostname}:4301`;
    }
    return 'http://localhost:4301';
  }

  // Production same-origin image: no baked URL. Derive from the browser origin;
  // the outer reverse proxy routes the WS upgrade to the api.
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
