import { baseLocale, isLocale, overwriteGetLocale } from '@paraglide/runtime.js';
import type { Metadata } from 'next';
import { Geist, Geist_Mono, Noto_Sans_JP } from 'next/font/google';
import { headers } from 'next/headers';
import { InstallerGate } from '@/components/installer-gate';
import { LocaleBridge } from '@/components/locale-bridge';
import { Providers } from '@/lib/providers';
import { publicRuntimeEnvScript } from '@/lib/public-runtime-env';
import { PARAGLIDE_LOCALE_HEADER } from '@/proxy';
import './globals.css';

// Two-font stack: Geist for Latin glyphs (covers most ASCII UI strings)
// with Noto Sans JP as the JP fallback. The browser's font-substitution
// fills in JP characters from Noto when Geist doesn't have the glyph,
// so the body's font-family lists Geist *first* — see globals.css.
const geistSans = Geist({
  variable: '--font-geist-sans',
  subsets: ['latin'],
});

// `display: 'swap'` avoids FOIT on first paint (each JP weight subset
// is ~70KB).
const notoSansJp = Noto_Sans_JP({
  variable: '--font-noto-sans-jp',
  subsets: ['latin'],
  display: 'swap',
  weight: ['400', '500', '600', '700'],
});

const geistMono = Geist_Mono({
  variable: '--font-geist-mono',
  subsets: ['latin'],
});

export const metadata: Metadata = {
  title: 'Crowi',
  description: 'Team collaboration wiki powered by Markdown',
};

export default async function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  // Bridge the per-request locale from proxy.ts (which resolves it from the
  // cookie) into the Server Component runtime. paraglideMiddleware's
  // AsyncLocalStorage doesn't survive across `NextResponse.next()`, so we
  // read the header it forwarded and overwrite getLocale for this request.
  const requestHeaders = await headers();
  const headerLocale = requestHeaders.get(PARAGLIDE_LOCALE_HEADER);
  const locale = headerLocale && isLocale(headerLocale) ? headerLocale : baseLocale;
  overwriteGetLocale(() => locale);

  // suppressHydrationWarning on <html>: next-themes injects the resolved theme
  // as a class via a blocking inline script before React hydrates, so the
  // server-rendered markup (no class) and the first client render differ on
  // this node. Suppressing here silences only the <html> node — real
  // mismatches in descendants are still reported.
  return (
    <html lang={locale} className="scroll-smooth" data-scroll-behavior="smooth" suppressHydrationWarning>
      <head>
        {/* Runtime public-env injection (feature-web-cross-origin-runtime-env):
            a SYNCHRONOUS inline script sets `window.__ENV` from the container's
            request-time NEXT_PUBLIC_* values, so one image targets any (incl.
            cross-origin) api host with no rebuild. It must run before the app's
            async chunks evaluate — a plain inline <script> does (during HTML
            parse), unlike a `beforeInteractive` script which is queued and can
            land after early module reads. This RootLayout otherwise has no
            explicit <head> (metadata + font className handle it). */}
        {/* biome-ignore lint/security/noDangerouslySetInnerHtml: trusted operator env; `<` is escaped in publicRuntimeEnvScript */}
        <script dangerouslySetInnerHTML={{ __html: publicRuntimeEnvScript() }} />
      </head>
      {/* suppressHydrationWarning: browser extensions (ColorZilla, Grammarly, …)
          inject attributes like `cz-shortcut-listen` onto <body> before React
          hydrates. Suppressing here only silences the one <body> node — real
          mismatches in descendants are still reported. */}
      <body suppressHydrationWarning className={`${geistSans.variable} ${notoSansJp.variable} ${geistMono.variable} antialiased`}>
        {/* Mirror the Server-Component `overwriteGetLocale` above into the
            client module graph so Client Components (which use a separate
            module instance during SSR) render the same locale on the server
            and on hydration. See locale-bridge.tsx. */}
        <LocaleBridge locale={locale}>
          <Providers>
            <InstallerGate>{children}</InstallerGate>
          </Providers>
        </LocaleBridge>
      </body>
    </html>
  );
}
