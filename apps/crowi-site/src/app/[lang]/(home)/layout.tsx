import { HomeLayout } from 'fumadocs-ui/layouts/home';
import { notFound } from 'next/navigation';
import type { ReactNode } from 'react';
import { isLocale } from '@/lib/i18n';
import { baseOptions } from '@/lib/layout-options';

export default async function MarketingLayout({ params, children }: { params: Promise<{ lang: string }>; children: ReactNode }) {
  const { lang } = await params;
  if (!isLocale(lang)) notFound();
  return <HomeLayout {...baseOptions(lang)}>{children}</HomeLayout>;
}
