'use client';

import { SidebarNavLinks } from './sidebar-nav-links';
import { MEMBER_DIR_PATH } from './sidebar-paths';
import { SidebarTree } from './sidebar-tree';

// Non-wiki routes that have no page hierarchy: their own dedicated
// surfaces (trash, my-page settings, OAuth, and the `_`-prefixed feature
// routes — search / notifications / member roster / history / …). On
// these the sidebar still shows its shared nav links, just no tree.
// `/user/{username}/…` is intentionally NOT excluded — those routes
// (my page / bookmarks / created pages) share the user's page hierarchy.
function isHierarchyPath(path: string): boolean {
  return !(
    path === MEMBER_DIR_PATH || // the member roster — a special list, no tree
    path.startsWith('/_') ||
    path === '/me' ||
    path.startsWith('/me/') ||
    path === '/oauth' ||
    path.startsWith('/oauth/') ||
    path === '/trash' ||
    path.startsWith('/trash/')
  );
}

/**
 * Left rail — the mirror of the right-rail TOC (`page-toc.tsx`): same
 * width, sticky offset, breakpoint, and symmetric position. The shared
 * nav links show on every page; the path-aware ancestry tree (identical
 * for list and content pages) shows only where the path maps to a wiki
 * hierarchy, so non-wiki routes keep the nav links without a misleading
 * tree.
 */
export function PageSidebar({ path }: { path: string }) {
  return (
    <aside
      aria-label="Page navigation"
      className="hidden min-[1440px]:block fixed top-24 right-[calc(50%+28rem+1.5rem)] w-56 max-h-[calc(100vh-7rem)] overflow-y-auto z-30"
    >
      <SidebarNavLinks />
      {isHierarchyPath(path) && (
        <>
          <div className="my-3 border-t border-border/60" aria-hidden />
          <SidebarTree path={path} />
        </>
      )}
    </aside>
  );
}
