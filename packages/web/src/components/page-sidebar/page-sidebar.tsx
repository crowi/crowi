'use client';

import { SidebarNavLinks } from './sidebar-nav-links';
import { MEMBER_DIR_PATH } from './sidebar-paths';
import { SidebarTree } from './sidebar-tree';

// Non-wiki route roots (themselves + their subtrees): my-page settings,
// OAuth, and trash. On these the sidebar shows its shared nav links but no
// hierarchy tree. `/user/{username}/…` is intentionally NOT here — those
// routes (my page / bookmarks / created pages) share the user's hierarchy.
const NON_HIERARCHY_ROOTS = ['/me', '/oauth', '/trash'];

function isHierarchyPath(path: string): boolean {
  if (path === MEMBER_DIR_PATH) return false; // the member roster — a special list
  if (path.startsWith('/_')) return false; // _edit / _history / _search / _user / _notifications / …
  return !NON_HIERARCHY_ROOTS.some((root) => path === root || path.startsWith(`${root}/`));
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
