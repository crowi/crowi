'use client';

import type { PageChildSegment } from '@crowi/api-contract';
import { Compass, FileText, Folder } from 'lucide-react';
import Link from 'next/link';
import { pagePathToHref } from '@/lib/page-path';
import { cn } from '@/lib/utils';

// rem of left padding added per tree depth, on top of a small base inset.
const INDENT_REM = 0.75;

interface SidebarRowProps {
  // Wiki path to link to (spaces are rendered as `+` for the URL).
  href: string;
  label: string;
  // Leading 14px icon slot — a lucide icon or an avatar.
  leading: React.ReactNode;
  depth: number;
  // The current node — primary highlight.
  isCurrent?: boolean;
  // On the path to the current node, but not it — kept un-muted so the
  // open branch reads as active without competing with `isCurrent`.
  isOpen?: boolean;
  // Optional marker shown after the label (e.g. the portal indicator).
  trailing?: React.ReactNode;
}

/**
 * One row of the sidebar tree — a bare `<Link>` (no `<li>`) so the tree
 * renderer can nest a child `<ul>` inside the same `<li>`. Presentational:
 * the caller supplies the href, label, leading icon, and active state.
 */
export function SidebarRow({ href, label, leading, depth, isCurrent, isOpen, trailing }: SidebarRowProps) {
  return (
    <Link
      href={pagePathToHref(href)}
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
      {leading}
      <span className="min-w-0 truncate">{label}</span>
      {trailing}
    </Link>
  );
}

/**
 * A tree row derived from an API child segment. A segment with descendants
 * (`count > 0`) or a portal page is a directory — it links to the
 * trailing-slashed portal path with a compass (portal) or folder (inferred)
 * icon; a bare page links to its slash-less page path.
 */
export function SidebarRowLink({ segment, depth, isCurrent, isOpen }: { segment: PageChildSegment; depth: number; isCurrent?: boolean; isOpen?: boolean }) {
  const isDirectory = segment.count > 0 || segment.hasPortal;
  const href = isDirectory ? segment.path : segment.path.replace(/\/$/, '');
  const label = isDirectory ? `${segment.segment}/` : segment.segment;
  // Directories always use the folder icon (even when a portal exists); a
  // portal is instead surfaced as a small marker after the label, so the
  // leading column stays a consistent folder/file split.
  const Icon = isDirectory ? Folder : FileText;
  return (
    <SidebarRow
      href={href}
      label={label}
      leading={<Icon className="h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden />}
      depth={depth}
      isCurrent={isCurrent}
      isOpen={isOpen}
      trailing={segment.hasPortal ? <Compass className="h-3 w-3 shrink-0 text-muted-foreground/70" aria-hidden /> : undefined}
    />
  );
}
