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
 * The viewport at which the rail fits beside the centred column, for the
 * `matchMedia` side of that decision. Below it the rail is `display: none`
 * and the flyout is the only way to reach the same navigation. The Tailwind
 * `min-[1440px]:` half is necessarily retyped at each site — a class string
 * assembled at runtime is invisible to Tailwind's scanner — so the number
 * has to be kept in step by hand: a rail that hides at one width while the
 * flyout appears at another leaves a band with no navigation at all.
 */
export const SIDEBAR_RAIL_QUERY = '(min-width: 1440px)';

/**
 * Shared nav links plus the path-aware ancestry tree — everything inside
 * the sidebar, independent of whether it is presented as the fixed rail
 * (`PageSidebar`) or the flyout panel (`SidebarFlyout`). The tree shows
 * only where the path maps to a wiki hierarchy, so non-wiki routes keep
 * the nav links without a misleading tree.
 */
export function SidebarBody({ path }: { path: string }) {
  return (
    <>
      <SidebarNavLinks />
      {isHierarchyPath(path) && (
        <>
          <div className="my-3 border-t border-border/60" aria-hidden />
          <SidebarTree path={path} />
        </>
      )}
    </>
  );
}
