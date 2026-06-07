import { baseLocale, isLocale, overwriteGetLocale } from '@paraglide/runtime.js';
import type { Metadata } from 'next';
import { Geist, Geist_Mono, Noto_Sans_JP } from 'next/font/google';
import { headers } from 'next/headers';
import { InstallerGate } from '@/components/installer-gate';
import { LocaleBridge } from '@/components/locale-bridge';
import { Providers } from '@/lib/providers';
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

  return (
    <html lang={locale} className="scroll-smooth" data-scroll-behavior="smooth">
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
