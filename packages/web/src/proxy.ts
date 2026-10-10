import { baseLocale, cookieMaxAge, cookieName, isLocale, locales, type Locale } from '@paraglide/runtime.js';
import { paraglideMiddleware } from '@paraglide/server.js';
import { type NextRequest, NextResponse } from 'next/server';

export const PARAGLIDE_LOCALE_HEADER = 'x-paraglide-locale';

/**
 * Paraglide JS request entrypoint.
 *
 * Resolves the per-request locale from the PARAGLIDE_LOCALE cookie and forwards
 * it to downstream handlers as an `x-paraglide-locale` request header. The root
 * layout reads that header and calls `overwriteGetLocale` so Server Components
 * see the same locale as the Client side — without this they would all fall
 * back to baseLocale (ja), producing a hydration mismatch the moment the user
 * switches languages.
 *
 * Without a cookie the locale is negotiated from Accept-Language (falling
 * back to baseLocale) and stored as the PARAGLIDE_LOCALE cookie.
 *
 * The locale strategy is pinned to `["cookie", "baseLocale"]` (see the
 * `paraglide:compile --strategy` flag in package.json). The compiler's default
 * also includes `globalVariable`, an in-memory module-global the *server can
 * never observe*: a client carrying a stale `_locale` (e.g. a tab kept open
 * across a locale switch or a dev-server restart) would resolve a different
 * locale than the server, and React reports a hydration mismatch. Restricting
 * the strategy to the cookie makes both sides resolve `cookie ?? baseLocale`
 * identically. We also read the cookie directly here rather than reusing the
 * `locale` paraglideMiddleware hands back, so the forwarded header stays
 * deterministic regardless of any future strategy tweak.
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
  return paraglideMiddleware(request, () => {
    const cookieLocale = request.cookies.get(cookieName)?.value;
    const hasCookie = cookieLocale !== undefined && isLocale(cookieLocale);
    const locale = hasCookie ? cookieLocale : localeFromAcceptLanguage(request.headers.get('accept-language'));
    const headers = new Headers(request.headers);
    headers.set(PARAGLIDE_LOCALE_HEADER, locale);
    const response = NextResponse.next({ request: { headers } });
    // Persist the negotiated locale so the browser carries it from the first
    // response on; LocaleSync then sees a cookie that already matches the
    // account's `lang` instead of forcing a reload to reconcile them.
    if (!hasCookie) response.cookies.set(cookieName, locale, { path: '/', maxAge: cookieMaxAge });
    return response;
  });
}

/** First Accept-Language tag whose base language we ship messages for; `baseLocale` when none. */
function localeFromAcceptLanguage(header: string | null): Locale {
  for (const entry of (header ?? '').split(',')) {
    const base = entry.split(';')[0]?.trim().toLowerCase().split('-')[0];
    if (base && (locales as readonly string[]).includes(base)) return base as Locale;
  }
  return baseLocale;
}

export const config = {
  // Run on every request that touches the app, but skip static assets and
  // Next.js' internal endpoints — none of those need locale handling.
  matcher: ['/((?!_next/static|_next/image|favicon\\.ico|logo|images).*)'],
};
