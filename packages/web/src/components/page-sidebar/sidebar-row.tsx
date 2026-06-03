'use client';

import type { PageChildSegment } from '@crowi/api-contract';
import { Compass, FileText, Folder } from 'lucide-react';
import Link from 'next/link';
import { pagePathToHref } from '@/lib/page-path';
import { cn } from '@/lib/utils';

// rem of left padding added per tree depth, on top of a small base inset.
const INDENT_REM = 0.75;

interface SidebarRowLinkProps {
  segment: PageChildSegment;
  depth: number;
  // The current page (deepest active node) — primary highlight.
  isCurrent?: boolean;
  // On the path to the current page, but not the leaf — kept un-muted so
  // the open branch reads as active without competing with `isCurrent`.
  isOpen?: boolean;
}

/**
 * One row of the sidebar tree. Renders a bare `<Link>` (no `<li>`) so the
 * tree renderer can nest a child `<ul>` inside the same `<li>`.
 *
 * A segment with descendants (`count > 0`) or a portal page is treated as
 * a directory: it links to the trailing-slashed portal path and shows a
 * compass (portal) or folder (inferred directory) icon. A bare page links
 * to its slash-less page path.
 */
export function SidebarRowLink({ segment, depth, isCurrent, isOpen }: SidebarRowLinkProps) {
  const isDirectory = segment.count > 0 || segment.hasPortal;
  // Directories link to the trailing-slashed portal path; a bare page links
  // to its slash-less page path.
  const href = pagePathToHref(isDirectory ? segment.path : segment.path.replace(/\/$/, ''));
  const label = isDirectory ? `${segment.segment}/` : segment.segment;
  const Icon = segment.hasPortal ? Compass : isDirectory ? Folder : FileText;

  return (
    <Link
      href={href}
      aria-current={isCurrent ? 'page' : undefined}
      title={label}
      className={cn(
        'flex items-center gap-1.5 rounded-md py-1 pr-2 text-sm leading-snug transition-colors',
        isCurrent
          ? 'bg-muted font-medium text-foreground'
          : isOpen
            ? 'text-foreground hover:bg-muted/60'
            : 'text-muted-foreground hover:bg-muted/60 hover:text-foreground',
      )}
      style={{ paddingLeft: `${depth * INDENT_REM + 0.5}rem` }}
    >
      <Icon className="h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden />
      <span className="truncate">{label}</span>
    </Link>
  );
}
