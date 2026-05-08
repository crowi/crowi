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
 */
export function middleware(request: NextRequest) {
  return paraglideMiddleware(request, () => NextResponse.next());
}

export const config = {
  // Run on every request that touches the app, but skip static assets and
  // Next.js' internal endpoints — none of those need locale handling.
  matcher: ['/((?!_next/static|_next/image|favicon\\.ico|logo|images).*)'],
};
