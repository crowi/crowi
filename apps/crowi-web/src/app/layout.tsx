import type { Metadata } from 'next';
import { headers } from 'next/headers';
import { Noto_Sans_JP, Geist_Mono } from 'next/font/google';
import { Providers } from '@/lib/providers';
import { InstallerGate } from '@/components/installer-gate';
import { PARAGLIDE_LOCALE_HEADER } from '@/proxy';
import { baseLocale, isLocale, overwriteGetLocale } from '@paraglide/runtime.js';
import './globals.css';

// Noto Sans JP covers both the JP and the latin glyphs used in the UI,
// so we pick it as the global sans. `display: 'swap'` avoids the FOIT on
// first paint (the larger JP weight set is ~70KB per weight subset).
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
    <html lang={locale} className="scroll-smooth">
      <body className={`${notoSansJp.variable} ${geistMono.variable} antialiased`}>
        <Providers>
          <InstallerGate>{children}</InstallerGate>
        </Providers>
      </body>
    </html>
  );
}
