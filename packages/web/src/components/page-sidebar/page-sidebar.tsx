'use client';

import { SidebarNavLinks } from './sidebar-nav-links';
import { SidebarTree } from './sidebar-tree';

/**
 * Left rail for wiki pages — the mirror of the right-rail TOC
 * (`page-toc.tsx`): same width, same sticky offset, hidden below the
 * same breakpoint, positioned symmetrically on the other side of the
 * centered content column. Shows the shared nav links on top and the
 * path-aware ancestry tree below (identical for list and content pages).
 */
export function PageSidebar({ path }: { path: string }) {
  return (
    <aside
      aria-label="Page navigation"
      className="hidden min-[1440px]:block fixed top-24 right-[calc(50%+28rem+1.5rem)] w-56 max-h-[calc(100vh-7rem)] overflow-y-auto z-30"
    >
      <SidebarNavLinks />
      <div className="my-3 border-t border-border/60" aria-hidden />
      <SidebarTree path={path} />
    </aside>
  );
}
