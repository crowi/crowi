import { Suspense } from 'react';
import { LoadingSpinner } from '@/components/ui/loading-spinner';
import { EditPageClient } from './edit-page-client';
import { m } from '@paraglide/messages.js';

export default function EditPage() {
  return (
    <Suspense fallback={<LoadingSpinner message={m['edit.editor_loading']()} />}>
      <EditPageClient />
    </Suspense>
  );
}
