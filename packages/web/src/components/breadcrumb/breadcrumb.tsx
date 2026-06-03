'use client';

import Link from 'next/link';
import { Home } from 'lucide-react';
import { pagePathToHref } from '@/lib/page-path';

interface BreadcrumbProps {
  path: string;
}

/**
 * Generate breadcrumb items from a path
 * For path "/foo/bar/baz", returns:
 *   [{ path: "/foo/", name: "foo" }, { path: "/foo/bar/", name: "bar" }]
 * The last segment is excluded as it represents the current page
 */
function getBreadcrumbItems(path: string): { path: string; name: string }[] {
  if (path === '/') return [];

  // Remove trailing slash for processing
  const cleanPath = path.replace(/\/$/, '');
  const segments = cleanPath.split('/').filter(Boolean);
  const items: { path: string; name: string }[] = [];

  // All segments except the last one (which is the current page)
  segments.slice(0, -1).forEach((segment, index) => {
    const segmentPath = '/' + segments.slice(0, index + 1).join('/') + '/';
    items.push({ path: segmentPath, name: segment });
  });

  return items;
}

export function Breadcrumb({ path }: BreadcrumbProps) {
  // Don't show breadcrumb on root path
  if (path === '/') return null;

  const items = getBreadcrumbItems(path);

  return (
    <nav className="flex items-center gap-1 text-sm text-muted-foreground mb-2">
      <Link href="/" className="hover:text-foreground transition-colors flex items-center gap-1">
        <Home className="h-4 w-4" />
        <span>Home</span>
      </Link>
      {items.map((item) => (
        <span key={item.path} className="flex items-center gap-1">
          <span>/</span>
          <Link href={pagePathToHref(item.path)} className="hover:text-foreground transition-colors">
            {item.name}
          </Link>
        </span>
      ))}
      <span>/</span>
    </nav>
  );
}
