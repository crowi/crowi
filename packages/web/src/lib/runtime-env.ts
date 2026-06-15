/**
 * Runtime reader for `NEXT_PUBLIC_*` env vars (feature-web-cross-origin-runtime-env).
 *
 * The root layout injects a SYNCHRONOUS inline `<script>` that sets
 * `window.__ENV = { …NEXT_PUBLIC_* … }` from the container's request-time env
 * (see `public-runtime-env.ts`). Because it is a plain inline script in
 * `<head>`, it runs during HTML parse — before the app's async chunks evaluate
 * — so even module-scope / early reads here see the value with no race. This is
 * what lets a single built `crowi/crowi-web` image target any api origin
 * (including cross-origin) via container env at start, with no rebuild.
 *
 * Read order:
 *   - **Browser**: `window.__ENV[key]` — the request-time injected value.
 *   - **SSR / build / SSG**: `window` is undefined → fall back to
 *     `BUILD_TIME_PUBLIC_ENV[key]`. At build/SSG that is typically undefined,
 *     which callers treat as "unset" (relative URL / `window.location` WS),
 *     preserving the same-origin default.
 *   - **Dev (`pnpm dev`)**: the build-time fallback carries any `.env` value.
 *
 * `BUILD_TIME_PUBLIC_ENV` uses literal `process.env.NEXT_PUBLIC_*` member
 * accesses on purpose, so Next's build-time inlining resolves them (a dynamic
 * `process.env[key]` would NOT be inlined). It is only the SSR/build/dev
 * fallback when `window.__ENV` is absent.
 */

declare global {
  interface Window {
    __ENV?: Record<string, string | undefined>;
  }
}

const BUILD_TIME_PUBLIC_ENV: Record<string, string | undefined> = {
  NEXT_PUBLIC_API_URL: process.env.NEXT_PUBLIC_API_URL,
  NEXT_PUBLIC_COLLAB_URL: process.env.NEXT_PUBLIC_COLLAB_URL,
};

/**
 * Read a `NEXT_PUBLIC_*` var at runtime. Returns the request-time value
 * injected into `window.__ENV` in the browser, falling back to the build-time
 * inlined value during SSR / build / dev.
 */
export function env(key: string): string | undefined {
  if (typeof window !== 'undefined' && window.__ENV) {
    const runtimeValue = window.__ENV[key];
    if (runtimeValue !== undefined) return runtimeValue;
  }
  return BUILD_TIME_PUBLIC_ENV[key];
}
