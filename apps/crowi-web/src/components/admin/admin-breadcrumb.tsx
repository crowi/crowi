'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { ChevronRight } from 'lucide-react';
import { ADMIN_SECTIONS, isAdminSectionKey } from './admin-sections';

/**
 * Breadcrumb shown above the admin main content area. Renders
 * "管理 > {セクション名}" derived from the current `/admin/{section}` path.
 * Returns null when on the bare `/admin` index.
 */
export function AdminBreadcrumb() {
  const pathname = usePathname();
  const segments = pathname.split('/').filter(Boolean); // ['admin', 'users']
  if (segments.length <= 1 || segments[0] !== 'admin') {
    return null;
  }

  const slug = segments[1];
  const label = isAdminSectionKey(slug) ? ADMIN_SECTIONS[slug] : slug;

  return (
    <nav className="mb-2 flex items-center gap-1 text-sm text-muted-foreground" aria-label="Admin breadcrumb">
      <Link href="/admin" className="transition-colors hover:text-foreground">
        管理
      </Link>
      <ChevronRight className="h-3.5 w-3.5" />
      <span className="text-foreground">{label}</span>
    </nav>
  );
}
