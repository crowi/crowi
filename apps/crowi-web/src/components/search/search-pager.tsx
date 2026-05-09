'use client';

import { Button } from '@/components/ui/button';
import { m } from '@paraglide/messages.js';

/**
 * Compute the visible page numbers for a numbered pager. Mirrors the shape
 * of `AdminPager` (used by `users-table.tsx`) but for the search endpoint
 * which returns `meta.total` instead of a server-rendered `Pager`.
 */
function buildPageRange(current: number, totalPages: number, span = 2): number[] {
  const start = Math.max(1, current - span);
  const end = Math.min(totalPages, current + span);
  const out: number[] = [];
  for (let i = start; i <= end; i += 1) out.push(i);
  return out;
}

interface SearchPagerProps {
  page: number;
  total: number;
  limit: number;
  onPageChange: (page: number) => void;
}

export function SearchPager({ page, total, limit, onPageChange }: SearchPagerProps) {
  const totalPages = Math.max(1, Math.ceil(total / limit));
  if (totalPages <= 1) return null;

  const pages = buildPageRange(page, totalPages);
  const hasPrev = page > 1;
  const hasNext = page < totalPages;
  const showLeftDots = pages.length > 0 && pages[0] > 1;
  const showRightDots = pages.length > 0 && pages[pages.length - 1] < totalPages;

  return (
    <nav className="flex items-center justify-center gap-1" aria-label={m['search.pager.aria_label']()}>
      <Button type="button" variant="outline" size="sm" disabled={!hasPrev} onClick={() => hasPrev && onPageChange(page - 1)}>
        {m['search.pager.previous']()}
      </Button>

      {showLeftDots && (
        <>
          <Button type="button" variant="outline" size="sm" onClick={() => onPageChange(1)} aria-label={`Page 1`}>
            1
          </Button>
          <span className="px-2 text-muted-foreground">...</span>
        </>
      )}

      {pages.map((p) => (
        <Button
          key={p}
          type="button"
          variant={p === page ? 'default' : 'outline'}
          size="sm"
          onClick={() => onPageChange(p)}
          aria-current={p === page ? 'page' : undefined}
        >
          {p}
        </Button>
      ))}

      {showRightDots && (
        <>
          <span className="px-2 text-muted-foreground">...</span>
          <Button type="button" variant="outline" size="sm" onClick={() => onPageChange(totalPages)} aria-label={`Page ${totalPages}`}>
            {totalPages}
          </Button>
        </>
      )}

      <Button type="button" variant="outline" size="sm" disabled={!hasNext} onClick={() => hasNext && onPageChange(page + 1)}>
        {m['search.pager.next']()}
      </Button>
    </nav>
  );
}
