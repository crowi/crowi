import type { Metadata } from 'next';
import { headers } from 'next/headers';
import { Geist, Noto_Sans_JP, Geist_Mono } from 'next/font/google';
import { Providers } from '@/lib/providers';
import { InstallerGate } from '@/components/installer-gate';
import { PARAGLIDE_LOCALE_HEADER } from '@/proxy';
import { baseLocale, isLocale, overwriteGetLocale } from '@paraglide/runtime.js';
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
      <head>
        {/*
          Recover a broken back/forward restore. When the user navigates
          away with a full-page load (e.g. clicking an attachment link to
          a raw file at /api/v2/attachments/<id>), the in-flight
          streaming-SSR response of the page they left is truncated; the
          browser can cache that partial document WITHOUT its RSC payload
          (`__next_f`). On a Back/Forward restore React then cannot
          hydrate, no effects run, and the app is stuck on "Loading..."
          forever (reloading fetches a complete document and fixes it).

          This inline script — which runs independently of React, so it
          works even when hydration never happens — detects exactly that
          state (a `back_forward` navigation whose `__next_f` stayed
          empty) and reloads once. A healthy back_forward restore has a
          populated `__next_f` so it never fires; the reload is a plain
          navigation (type !== 'back_forward') so it cannot loop.
        */}
        <script
          dangerouslySetInnerHTML={{
            __html:
              "(function(){var n=performance.getEntriesByType('navigation')[0];if(n&&n.type==='back_forward'){setTimeout(function(){if(!window.__next_f||window.__next_f.length===0){location.reload()}},2000)}})()",
          }}
        />
      </head>
      <body className={`${geistSans.variable} ${notoSansJp.variable} ${geistMono.variable} antialiased`}>
        <Providers>
          <InstallerGate>{children}</InstallerGate>
        </Providers>
      </body>
    </html>
  );
}
