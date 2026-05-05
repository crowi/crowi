'use client';

import { useState } from 'react';
import { Loader2, AlertCircle } from 'lucide-react';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Card } from '@/components/ui/card';
import { PageListItem } from './page-list-item';
import { Pagination } from './pagination';
import { PageContent } from '@/components/page-view/page-content';
import { usePageList } from '@/lib/use-page-list';
import type { ListPagesRequest, PageWithRevision } from '@crowi/api-contract';

interface PageListProps {
  initialParams?: Partial<ListPagesRequest>;
}

export function PageList({ initialParams = {} }: PageListProps) {
  const [params, setParams] = useState<ListPagesRequest>({
    limit: 50,
    offset: 0,
    ...initialParams,
  });

  const { data, isLoading, error } = usePageList(params);

  const handlePageChange = (offset: number) => {
    setParams((prev) => ({ ...prev, offset }));
    // Scroll to top when page changes
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-12">
        <Loader2 className="h-8 w-8 animate-spin text-primary" />
        <span className="ml-2 text-muted-foreground">Loading pages...</span>
      </div>
    );
  }

  if (error) {
    return (
      <Alert variant="destructive">
        <AlertCircle className="h-4 w-4" />
        <AlertDescription>Failed to load pages. Please try again later.</AlertDescription>
      </Alert>
    );
  }

  if (!data || (data.pages.length === 0 && !data.portalPage)) {
    return (
      <Card className="p-8 text-center">
        <p className="text-muted-foreground">No pages found.</p>
      </Card>
    );
  }

  return (
    <div className="space-y-4">
      {/* Portal Page */}
      {data.portalPage && (
        <Card className="p-6">
          <PageContent page={data.portalPage as PageWithRevision} />
        </Card>
      )}

      {/* Page List */}
      {data.pages.length > 0 && (
        <Card className="divide-y">
          {data.pages.map((page) => (
            <PageListItem key={page._id} page={page} />
          ))}
        </Card>
      )}

      {/* Pagination */}
      {data.pages.length > 0 && <Pagination pager={data.pager} limit={params.limit} onPageChange={handlePageChange} />}
    </div>
  );
}
