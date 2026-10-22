'use client';

import Link from 'next/link';
import { ReloadHint } from '@/components/reload-hint';
import { useAppInfo } from '@/lib/use-app-info';
import { useReloadOnCurrentRoute } from '@/lib/use-reload-on-current-route';

/**
 * Logo lockup link used by both the (auth) and (admin) headers. Renders the
 * dark icon + configured site title in primary teal when set, otherwise the
 * full Crowi lettering lockup. On the top page itself a click refreshes it.
 */
export function SiteBrand() {
  const { data: appInfo } = useAppInfo();
  const { isCurrent, onClick } = useReloadOnCurrentRoute('/');
  return (
    <Link
      href="/"
      onClick={onClick}
      className="group relative flex items-center gap-2 text-foreground hover:opacity-80 transition-opacity min-w-0"
      aria-label={appInfo?.title ?? 'Crowi'}
    >
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
      {/* Hung outside the lockup so the header's search field sits at the same x on every page. Below md the
          mobile search button sits right there, and touch has no hover to reveal it anyway. */}
      {isCurrent && <ReloadHint className="pointer-events-none absolute left-full top-1/2 ml-1 -translate-y-1/2 max-md:hidden" />}
    </Link>
  );
}
