'use client';

import { m } from '@paraglide/messages.js';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { computePagerWindow } from '@/lib/pager-range';

interface NumberedPagerProps {
  mode: 'numbered';
  /** 1-based current page. */
  page: number;
  totalPages: number;
  onPageChange: (page: number) => void;
  /**
   * `aria-label` for the `<nav>`. Left to the caller because the read-aloud
   * context differs (search results vs. a generic admin table) — see spec
   * "未確定事項" (kept caller-supplied by design, not unified).
   */
  ariaLabel: string;
}

interface PrevNextPagerProps {
  mode: 'prev-next';
  /** 1-based current page, rendered as `common.pager.page_label`. */
  page: number;
  hasPrev: boolean;
  hasNext: boolean;
  onPrev: () => void;
  onNext: () => void;
}

export type PagerProps = NumberedPagerProps | PrevNextPagerProps;

/**
 * Single pagination UI primitive, unifying the 3 previously-independent
 * implementations (offset prev/next, client-computed numbered, and
 * server-computed numbered — feature-unified-pager). `mode` is a
 * discriminated union so each call site only carries the props its layout
 * actually needs.
 */
export function Pager(props: PagerProps) {
  if (props.mode === 'numbered') {
    return <NumberedPager {...props} />;
  }
  return <PrevNextPager {...props} />;
}

function NumberedPager({ page, totalPages, onPageChange, ariaLabel }: NumberedPagerProps) {
  if (totalPages <= 1) return null;

  const { pages, showLeftDots, showRightDots } = computePagerWindow(page, totalPages);
  const hasPrev = page > 1;
  const hasNext = page < totalPages;

  return (
    <nav className="flex items-center justify-center gap-1" aria-label={ariaLabel}>
      <Button type="button" variant="outline" size="sm" disabled={!hasPrev} onClick={() => hasPrev && onPageChange(page - 1)}>
        {m['common.pager.previous']()}
      </Button>

      {showLeftDots && (
        <>
          <Button type="button" variant="outline" size="sm" onClick={() => onPageChange(1)} aria-label={m['common.pager.page_aria']({ page: 1 })}>
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
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => onPageChange(totalPages)}
            aria-label={m['common.pager.page_aria']({ page: totalPages })}
          >
            {totalPages}
          </Button>
        </>
      )}

      <Button type="button" variant="outline" size="sm" disabled={!hasNext} onClick={() => hasNext && onPageChange(page + 1)}>
        {m['common.pager.next']()}
      </Button>
    </nav>
  );
}

function PrevNextPager({ page, hasPrev, hasNext, onPrev, onNext }: PrevNextPagerProps) {
  return (
    <div className="flex items-center justify-between gap-4 py-4">
      <div className="text-sm text-muted-foreground">{m['common.pager.page_label']({ page })}</div>

      <div className="flex items-center gap-2">
        <Button variant="outline" size="sm" onClick={onPrev} disabled={!hasPrev}>
          <ChevronLeft className="h-4 w-4 mr-1" />
          {m['common.pager.previous']()}
        </Button>

        <Button variant="outline" size="sm" onClick={onNext} disabled={!hasNext}>
          {m['common.pager.next']()}
          <ChevronRight className="h-4 w-4 ml-1" />
        </Button>
      </div>
    </div>
  );
}
