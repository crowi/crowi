'use client';

import { useParams } from 'next/navigation';
import { PageList } from '@/components/page-list/page-list';

export default function PagesPathPage() {
  const params = useParams();
  const pathSegments = params.path as string[] | undefined;
  const path = pathSegments ? `/${pathSegments.join('/')}` : undefined;

  return (
    <div className="container mx-auto py-8 max-w-5xl">
      <div className="mb-6">
        <h1 className="text-3xl font-bold tracking-tight">
          {path ? `Pages under ${path}` : 'All Pages'}
        </h1>
        <p className="text-muted-foreground mt-2">
          {path
            ? `Browse all pages under the ${path} path`
            : 'Browse all pages you have access to'}
        </p>
      </div>

      <PageList initialParams={path ? { path } : {}} />
    </div>
  );
}
