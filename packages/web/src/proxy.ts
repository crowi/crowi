import { paraglideMiddleware } from '@paraglide/server.js';
import { NextResponse, type NextRequest } from 'next/server';

export const PARAGLIDE_LOCALE_HEADER = 'x-paraglide-locale';

/**
 * Paraglide JS request entrypoint.
 *
 * Resolves the per-request locale from the PARAGLIDE_LOCALE cookie (via
 * paraglideMiddleware) and forwards it to downstream handlers as an
 * `x-paraglide-locale` request header. The root layout reads that header and
 * calls `overwriteGetLocale` so Server Components see the same locale as the
 * Client side — without this they would all fall back to baseLocale (ja),
 * producing a hydration mismatch the moment the user switches languages.
 *
 * paraglideMiddleware also sets up its AsyncLocalStorage scope, but Next.js'
 * Server Component rendering happens after `NextResponse.next()` returns and
 * therefore outside that scope, so the AsyncLocalStorage alone is not enough.
 * The header forwarding is the bridge.
 *
 * Uses the Next.js 16 `proxy.ts` convention (renamed from `middleware.ts` in
 * v16). The proxy runtime is Node — that's a hard requirement here because
 * paraglideMiddleware relies on AsyncLocalStorage, which is unavailable in
 * the Edge runtime.
 */
export function proxy(request: NextRequest) {
  return paraglideMiddleware(request, ({ locale }) => {
    const headers = new Headers(request.headers);
    headers.set(PARAGLIDE_LOCALE_HEADER, locale);
    return NextResponse.next({ request: { headers } });
  });
}

export const config = {
  // Run on every request that touches the app, but skip static assets and
  // Next.js' internal endpoints — none of those need locale handling.
  matcher: ['/((?!_next/static|_next/image|favicon\\.ico|logo|images).*)'],
};
