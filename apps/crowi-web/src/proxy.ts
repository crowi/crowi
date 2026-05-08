import { paraglideMiddleware } from '@/paraglide/server.js';
import { NextResponse, type NextRequest } from 'next/server';

/**
 * Paraglide JS request entrypoint.
 *
 * Wraps each request with `paraglideMiddleware` so the per-request locale
 * (resolved from the PARAGLIDE_LOCALE cookie) is stored in AsyncLocalStorage
 * before the route handler runs. Without this, `getLocale()` in Server
 * Components always returns the base locale (`ja`), which produces a hydration
 * mismatch when the Client side reads the cookie and renders a different
 * locale.
 *
 * Uses the Next.js 16 `proxy.ts` convention (renamed from `middleware.ts` in
 * v16). The proxy runtime is Node — that's a hard requirement here because
 * paraglideMiddleware relies on AsyncLocalStorage, which is unavailable in
 * the Edge runtime. The legacy `middleware.ts` filename in v16 still defaults
 * to Edge, so a rename is mandatory rather than cosmetic.
 */
export function proxy(request: NextRequest) {
  return paraglideMiddleware(request, () => NextResponse.next());
}

export const config = {
  // Run on every request that touches the app, but skip static assets and
  // Next.js' internal endpoints — none of those need locale handling.
  matcher: ['/((?!_next/static|_next/image|favicon\\.ico|logo|images).*)'],
};
