'use client';

import { m } from '@paraglide/messages.js';
import { usePageChildren } from '@/lib/use-page-children';
import { SidebarRowLink } from './sidebar-row';

/**
 * List-page sidebar: the first-level segments directly under the portal
 * path being viewed (e.g. `rfc/`, `ops/`, `mtg/`, `project/` under
 * `/crowi/`). Flat — no expansion, since the page body already shows the
 * full listing.
 */
export function ListSidebar({ path }: { path: string }) {
  const { data, isLoading } = usePageChildren(path);
  const children = data?.children ?? [];

  if (isLoading) {
    return (
      <div className="space-y-1.5" aria-hidden>
        {Array.from({ length: 5 }).map((_, i) => (
          <div key={i} className="h-5 animate-pulse rounded bg-muted/60" />
        ))}
      </div>
    );
  }

  if (children.length === 0) {
    return <p className="px-2 py-1 text-xs text-muted-foreground">{m['sidebar.empty']()}</p>;
  }

  return (
    <ul className="space-y-0.5">
      {children.map((child) => (
        <li key={child.segment}>
          <SidebarRowLink segment={child} depth={0} />
        </li>
      ))}
    </ul>
  );
}
