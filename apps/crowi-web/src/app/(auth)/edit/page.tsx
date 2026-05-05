import { Suspense } from 'react';
import { LoadingSpinner } from '@/components/ui/loading-spinner';
import { EditPageClient } from './edit-page-client';

export default function EditPage() {
  return (
    <Suspense fallback={<LoadingSpinner message="Loading editor..." />}>
      <EditPageClient />
    </Suspense>
  );
}
