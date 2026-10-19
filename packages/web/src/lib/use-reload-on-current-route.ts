'use client';

import { useQueryClient } from '@tanstack/react-query';
import { usePathname, useSearchParams } from 'next/navigation';
import type { MouseEvent } from 'react';
import { isPlainPrimaryClick } from '@/lib/is-plain-primary-click';
import { attachmentsKeys } from '@/lib/use-attachments';
import { backlinksKeys } from '@/lib/use-backlinks';
import { commentKeys } from '@/lib/use-page-comments';
import { invalidatePageContentQueries } from '@/lib/use-page-mutations';

/**
 * A link back to the route the viewer is already on does nothing visible on
 * its own: the router keeps the cached queries, so the lists on the page stay
 * as they were until a full reload. On the current route, a plain click
 * refetches the page content, its lists and the comment / attachment /
 * backlink counts a portal shows, in place instead. The rest of the cache
 * (session, realtime tokens) is left alone: refetching a token reconnects its
 * socket. A URL carrying a query (an old revision of the page, say) is a
 * different view, so the link still navigates from there. Modified clicks
 * (new tab, new window) are left to the browser.
 */
export function useReloadOnCurrentRoute(href: string) {
  const pathname = usePathname();
  const queryClient = useQueryClient();
  const searchParams = useSearchParams();
  const isCurrent = pathname === href && (searchParams?.toString() ?? '') === '';

  const onClick = (event: MouseEvent<HTMLAnchorElement>) => {
    if (!isCurrent || event.defaultPrevented || !isPlainPrimaryClick(event)) return;
    event.preventDefault();
    invalidatePageContentQueries(queryClient);
    for (const queryKey of [commentKeys.all, attachmentsKeys.all, backlinksKeys.all]) {
      void queryClient.invalidateQueries({ queryKey });
    }
  };

  return { isCurrent, onClick };
}
