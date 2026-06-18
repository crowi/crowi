'use client';

import { Fragment } from 'react';
import Link from 'next/link';
import { Home, MoreHorizontal } from 'lucide-react';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { pagePathToHref } from '@/lib/page-path';
import { cn } from '@/lib/utils';

interface BreadcrumbProps {
  path: string;
}

interface BreadcrumbItem {
  path: string;
  name: string;
}

/**
 * Generate breadcrumb items from a path
 * For path "/foo/bar/baz", returns:
 *   [{ path: "/foo/", name: "foo" }, { path: "/foo/bar/", name: "bar" }]
 * The last segment is excluded as it represents the current page
 */
function getBreadcrumbItems(path: string): BreadcrumbItem[] {
  if (path === '/') return [];

  // Remove trailing slash for processing
  const cleanPath = path.replace(/\/$/, '');
  const segments = cleanPath.split('/').filter(Boolean);
  const items: BreadcrumbItem[] = [];

  // All segments except the last one (which is the current page)
  segments.slice(0, -1).forEach((segment, index) => {
    const segmentPath = '/' + segments.slice(0, index + 1).join('/') + '/';
    items.push({ path: segmentPath, name: segment });
  });

  return items;
}

const linkClass = 'hover:text-foreground transition-colors';

function BreadcrumbSeparator() {
  return <span className="shrink-0">/</span>;
}

/** A `…` trigger that reveals the collapsed middle ancestors in a dropdown. */
function CollapsedItems({ items }: { items: BreadcrumbItem[] }) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        className="flex shrink-0 items-center rounded p-0.5 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        aria-label="Show collapsed breadcrumb levels"
      >
        <MoreHorizontal className="h-4 w-4" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start">
        {items.map((item) => (
          <DropdownMenuItem key={item.path} asChild>
            <Link href={pagePathToHref(item.path)}>{item.name}</Link>
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export function Breadcrumb({ path }: BreadcrumbProps) {
  // Don't show breadcrumb on root path
  if (path === '/') return null;

  const items = getBreadcrumbItems(path);
  const lastIndex = items.length - 1;
  // The ancestors between the first and the immediate parent. When the path is
  // deep these get collapsed behind a `…` dropdown on mobile so the trail stays
  // on a single line and never runs off the viewport; on md+ they stay inline.
  const middleItems = items.slice(1, lastIndex);

  return (
    <nav className="flex min-w-0 items-center gap-1 text-sm text-muted-foreground mb-2">
      <Link href="/" className={cn(linkClass, 'flex shrink-0 items-center gap-1')}>
        <Home className="h-4 w-4" />
        <span>Home</span>
      </Link>
      {items.map((item, index) => {
        const isFirst = index === 0;
        const isLast = index === lastIndex;
        const isMiddle = !isFirst && !isLast;
        return (
          <Fragment key={item.path}>
            {/* Mobile-only `…` dropdown, injected once in place of the first
                collapsed item. On md+ the inline middle items below take over. */}
            {isMiddle && index === 1 && (
              <span className="flex items-center gap-1 md:hidden">
                <BreadcrumbSeparator />
                <CollapsedItems items={middleItems} />
              </span>
            )}
            <span
              className={cn(
                'items-center gap-1',
                // first / last stay on the line at every width; the middle ones
                // only show from md up (collapsed into the dropdown on mobile).
                isMiddle ? 'hidden md:flex' : 'flex',
                // let first / last shrink + ellipsize instead of overflowing when
                // an individual segment name is very long.
                !isMiddle && 'min-w-0',
              )}
            >
              <BreadcrumbSeparator />
              <Link href={pagePathToHref(item.path)} className={cn(linkClass, !isMiddle && 'truncate')}>
                {item.name}
              </Link>
            </span>
          </Fragment>
        );
      })}
      <BreadcrumbSeparator />
    </nav>
  );
}
