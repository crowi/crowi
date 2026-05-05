import { Suspense } from 'react';
import { Loader2 } from 'lucide-react';
import { EditPageClient } from './edit-page-client';

export default function EditPage() {
  return (
    <Suspense
      fallback={
        <div className="flex items-center justify-center py-16">
          <Loader2 className="h-8 w-8 animate-spin text-primary" />
          <span className="ml-3 text-muted-foreground">Loading editor...</span>
        </div>
      }
    >
      <EditPageClient />
    </Suspense>
  );
}
