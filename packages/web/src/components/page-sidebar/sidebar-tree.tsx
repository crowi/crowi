'use client';

import { CornerLeftUp } from 'lucide-react';
import Link from 'next/link';
import { useMemo } from 'react';
import { m } from '@paraglide/messages.js';
import { usePageChildrenLevels } from '@/lib/use-page-children';
import { cn } from '@/lib/utils';
import { pageDisplayName, pagePathToHref } from '@/lib/page-path';
import { SidebarRowLink } from './sidebar-row';
import { pageSidebarLayout } from './sidebar-paths';

/**
 * The page sidebar hierarchy — the current path's ancestry as an
 * expanded tree, identical for list (portal) and content pages (see
 * `pageSidebarLayout`). Each ancestor directory's children are fetched
 * in parallel; the branch toward the current node is opened down to it,
 * and a "⤴" affordance above the root jumps to the parent list page.
 */
export function SidebarTree({ path }: { path: string }) {
  const layout = useMemo(() => pageSidebarLayout(path), [path]);
  const results = usePageChildrenLevels(layout.levelPaths);
  // Positionally aligned with layout.levelPaths.
  const levels = results.map((r) => r.data?.children ?? []);
  const isLoading = results.some((r) => r.isLoading);

  // Recursively render the tree from level `k` down, opening only the
  // active branch at each level.
  const renderLevel = (k: number): React.ReactNode => {
    const children = levels[k] ?? [];
    if (children.length === 0) return null;
    const activeSegment = layout.activeSegments[k];
    const isDeepest = k === layout.levelPaths.length - 1;

    return (
      <ul className="space-y-0.5">
        {children.map((child) => {
          const isActive = activeSegment !== null && child.segment === activeSegment;
          const isCurrent = k === layout.currentLevelIndex && child.segment === layout.currentSegment;
          return (
            <li key={child.segment}>
              <SidebarRowLink segment={child} depth={k} isCurrent={isCurrent} isOpen={isActive && !isCurrent} />
              {isActive && !isDeepest && renderLevel(k + 1)}
            </li>
          );
        })}
      </ul>
    );
  };

  if (isLoading) {
    return (
      <div className="space-y-1.5" aria-hidden>
        {Array.from({ length: 6 }).map((_, i) => (
          <div key={i} className="h-5 animate-pulse rounded bg-muted/60" style={{ marginLeft: `${Math.min(i, 3) * 0.5}rem` }} />
        ))}
      </div>
    );
  }

  return (
    <div className="space-y-0.5">
      {layout.upPath && (
        <Link
          href={pagePathToHref(layout.upPath)}
          title={layout.upPath}
          className={cn(
            'flex items-center gap-1.5 rounded-md px-2 py-1 text-xs text-muted-foreground transition-colors',
            'hover:bg-muted/60 hover:text-foreground',
          )}
        >
          <CornerLeftUp className="h-3.5 w-3.5 shrink-0" aria-hidden />
          <span className="truncate">{pageDisplayName(layout.upPath) || m['sidebar.up_to_parent']()}</span>
        </Link>
      )}
      {renderLevel(0)}
    </div>
  );
}
