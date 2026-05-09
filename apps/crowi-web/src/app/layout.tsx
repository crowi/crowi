import type { Metadata } from 'next';
import { headers } from 'next/headers';
import { Geist, Geist_Mono } from 'next/font/google';
import { Providers } from '@/lib/providers';
import { InstallerGate } from '@/components/installer-gate';
import { PARAGLIDE_LOCALE_HEADER } from '@/proxy';
import { baseLocale, isLocale, overwriteGetLocale } from '@paraglide/runtime.js';
import './globals.css';

const geistSans = Geist({
  variable: '--font-geist-sans',
  subsets: ['latin'],
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
    <html lang={locale}>
      <body className={`${geistSans.variable} ${geistMono.variable} antialiased`}>
        <Providers>
          <InstallerGate>{children}</InstallerGate>
        </Providers>
      </body>
    </html>
  );
}
