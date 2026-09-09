'use client';

import { SidebarBody } from './sidebar-body';
import { SIDEBAR_SCROLLER_ATTR } from './sidebar-scroll';

/**
 * Left rail — the mirror of the right-rail TOC (`page-toc.tsx`): same
 * width, sticky offset, breakpoint, and symmetric position. Below the
 * breakpoint there is no room for it beside the centred column, and it
 * hides; `SidebarFlyout` in the header carries the same navigation there.
 */
export function PageSidebar({ path }: { path: string }) {
  return (
    <aside
      aria-label="Page navigation"
      // The tree finds this element to keep the current node in view; the
      // rail, not the window, is what scrolls.
      {...{ [SIDEBAR_SCROLLER_ATTR]: '' }}
      className="hidden min-[1440px]:block fixed top-24 right-[calc(50%+28rem+1.5rem)] w-56 max-h-[calc(100vh-7rem)] overflow-y-auto z-30"
    >
      <SidebarBody path={path} />
    </aside>
  );
}
