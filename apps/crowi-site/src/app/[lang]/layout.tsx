import { RootProvider } from 'fumadocs-ui/provider/next';
import { notFound } from 'next/navigation';
import type { ReactNode } from 'react';
import { isLocale, locales } from '@/lib/i18n';
import { i18nUI } from '@/lib/layout-options';

export function generateStaticParams() {
  return locales.map((lang) => ({ lang }));
}

export default async function LangLayout({ params, children }: { params: Promise<{ lang: string }>; children: ReactNode }) {
  const { lang } = await params;
  if (!isLocale(lang)) notFound();

  return (
    <html lang={lang} suppressHydrationWarning>
      <body className="flex min-h-screen flex-col">
        <RootProvider i18n={i18nUI.provider(lang)}>{children}</RootProvider>
      </body>
    </html>
  );
}
