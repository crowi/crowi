'use client';

import Link from 'next/link';
import { useAppInfo } from '@/lib/use-app-info';

/**
 * Logo lockup link used by both the (auth) and (admin) headers. Renders the
 * dark icon + configured site title in primary teal when set, otherwise the
 * full Crowi lettering lockup.
 */
export function SiteBrand() {
  const { data: appInfo } = useAppInfo();
  return (
    <Link href="/" className="flex items-center gap-2 text-foreground hover:opacity-80 transition-opacity min-w-0" aria-label={appInfo?.title ?? 'Crowi'}>
      {appInfo?.title ? (
        <>
          {/* Inverse (white) icon under .dark so it reads on the dark header;
              swapped via CSS so there is no theme-resolution flash. */}
          <img src="/logo/icon.png" alt="" className="h-6 w-6 shrink-0 dark:hidden" />
          <img src="/logo/icon-inverse.png" alt="" className="h-6 w-6 shrink-0 hidden dark:block" />
          <span className="text-base font-semibold truncate text-primary">{appInfo.title}</span>
        </>
      ) : (
        <>
          <img src="/logo/500w.png" alt="Crowi" className="h-6 w-auto shrink-0 dark:hidden" />
          <img src="/logo/500w-inverse.png" alt="Crowi" className="h-6 w-auto shrink-0 hidden dark:block" />
        </>
      )}
    </Link>
  );
}
