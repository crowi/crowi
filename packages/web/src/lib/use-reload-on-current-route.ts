'use client';

import { useQueryClient } from '@tanstack/react-query';
import { usePathname, useSearchParams } from 'next/navigation';
import type { MouseEvent } from 'react';

/**
 * A link back to the route the viewer is already on does nothing visible on
 * its own: the router keeps the cached queries, so the lists on the page stay
 * as they were until a full reload. On the current route, a plain click
 * refetches the page's queries in place instead. A URL carrying a query (an
 * old revision of the page, say) is a different view, so the link still
 * navigates from there. Modified clicks (new tab, new window) are left to the
 * browser.
 */
export function useReloadOnCurrentRoute(href: string) {
  const pathname = usePathname();
  const queryClient = useQueryClient();
  const searchParams = useSearchParams();
  const isCurrent = pathname === href && (searchParams?.toString() ?? '') === '';

  const onClick = (event: MouseEvent<HTMLAnchorElement>) => {
    if (!isCurrent || event.defaultPrevented || event.button !== 0) return;
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    void queryClient.invalidateQueries();
  };

  return { isCurrent, onClick };
}
