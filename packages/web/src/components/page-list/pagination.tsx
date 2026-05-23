'use client';

import type { Pager } from '@crowi/api-contract';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { Button } from '@/components/ui/button';

interface PaginationProps {
  pager: Pager;
  limit: number;
  onPageChange: (offset: number) => void;
}

export function Pagination({ pager, limit, onPageChange }: PaginationProps) {
  const currentPage = Math.floor(pager.offset / limit) + 1;
  const hasPrev = pager.prev !== null;
  const hasNext = pager.next !== null;

  return (
    <div className="flex items-center justify-between gap-4 py-4">
      <div className="text-sm text-muted-foreground">Page {currentPage}</div>

      <div className="flex items-center gap-2">
        <Button variant="outline" size="sm" onClick={() => pager.prev !== null && onPageChange(pager.prev)} disabled={!hasPrev}>
          <ChevronLeft className="h-4 w-4 mr-1" />
          Previous
        </Button>

        <Button variant="outline" size="sm" onClick={() => pager.next !== null && onPageChange(pager.next)} disabled={!hasNext}>
          Next
          <ChevronRight className="h-4 w-4 ml-1" />
        </Button>
      </div>
    </div>
  );
}
