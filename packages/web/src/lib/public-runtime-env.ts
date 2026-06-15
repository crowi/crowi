import 'server-only';

/**
 * Public env keys exposed to the browser via `window.__ENV`. Keep in sync with
 * the build-time fallback in `runtime-env.ts`.
 */
const PUBLIC_ENV_KEYS = ['NEXT_PUBLIC_API_URL', 'NEXT_PUBLIC_COLLAB_URL'] as const;

/**
 * Read the public `NEXT_PUBLIC_*` env at REQUEST time on the server — the
 * container's runtime values, not the build-time inlined ones.
 *
 * Access goes through a loop variable (`source[key]`) rather than the literal
 * `process.env.NEXT_PUBLIC_*` member form, so Next's build-time static
 * replacement does NOT apply and the values are read live from the running
 * process. The root layout is already dynamic (it calls `headers()`), so this
 * runs per request.
 */
export function readPublicRuntimeEnv(): Record<string, string> {
  const source: NodeJS.ProcessEnv = process.env;
  const out: Record<string, string> = {};
  for (const key of PUBLIC_ENV_KEYS) {
    const value = source[key];
    if (value != null && value.length > 0) out[key] = value;
  }
  return out;
}

/**
 * Body for a **synchronous** inline `<script>` placed in the document `<head>`
 * that sets `window.__ENV`. Being a plain inline script (not `next/script` /
 * `beforeInteractive`), it runs during HTML parse — before the app's async
 * chunks evaluate — so any early read of `window.__ENV` (e.g. cross-origin api
 * URL resolution) sees the value with no race.
 *
 * `<` is escaped to `<` so an env value can never close the script tag.
 */
export function publicRuntimeEnvScript(): string {
  const json = JSON.stringify(readPublicRuntimeEnv()).replace(/</g, '\\u003c');
  return `window.__ENV=${json};`;
}
