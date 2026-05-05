'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { Loader2, AlertCircle, Lock } from 'lucide-react';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { usePage } from '@/lib/use-page';

interface IdRedirectorProps {
  pageId: string;
}

export function IdRedirector({ pageId }: IdRedirectorProps) {
  const router = useRouter();
  const { page, isLoading, isError, error, notFound, notGranted } = usePage({ page_id: pageId });

  // Use replace (not push) so the id URL stays out of browser history.
  useEffect(() => {
    if (page?.path) {
      router.replace(page.path);
    }
  }, [page?.path, router]);

  if (page) {
    return (
      <div className="flex items-center justify-center py-16">
        <Loader2 className="h-8 w-8 animate-spin text-primary" />
        <span className="ml-3 text-muted-foreground">Redirecting to {page.path}...</span>
      </div>
    );
  }

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-16">
        <Loader2 className="h-8 w-8 animate-spin text-primary" />
        <span className="ml-3 text-muted-foreground">Looking up page...</span>
      </div>
    );
  }

  if (notGranted) {
    return (
      <Card className="border-amber-200 dark:border-amber-800">
        <CardHeader>
          <div className="flex items-center gap-2">
            <Lock className="h-5 w-5 text-amber-500" />
            <CardTitle>Access Denied</CardTitle>
          </div>
          <CardDescription>You do not have permission to view this page.</CardDescription>
        </CardHeader>
        <CardContent>
          <p className="text-muted-foreground">This page is private or you need to be granted access by the owner.</p>
          <div className="mt-4">
            <Button variant="outline" onClick={() => router.back()}>
              Go Back
            </Button>
          </div>
        </CardContent>
      </Card>
    );
  }

  if (notFound) {
    return (
      <Card>
        <CardHeader>
          <div className="flex items-center gap-2">
            <AlertCircle className="h-5 w-5 text-muted-foreground" />
            <CardTitle>Page Not Found</CardTitle>
          </div>
          <CardDescription>
            No page exists for id <code className="bg-muted px-2 py-0.5 rounded">{pageId}</code>.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <p className="text-muted-foreground mb-4">The page may have been deleted or the link may be incorrect.</p>
          <div className="flex gap-2">
            <Button variant="default" onClick={() => router.push('/')}>
              Go Home
            </Button>
            <Button variant="outline" onClick={() => router.back()}>
              Go Back
            </Button>
          </div>
        </CardContent>
      </Card>
    );
  }

  if (isError) {
    return (
      <Alert variant="destructive">
        <AlertCircle className="h-4 w-4" />
        <AlertTitle>Error</AlertTitle>
        <AlertDescription>Failed to look up page. {error?.message || 'Please try again later.'}</AlertDescription>
      </Alert>
    );
  }

  return null;
}
