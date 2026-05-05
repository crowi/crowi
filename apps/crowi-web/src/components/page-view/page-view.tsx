'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { Loader2, AlertCircle, Trash2, Lock, FilePlus2 } from 'lucide-react';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { usePage } from '@/lib/use-page';
import { useRevertDeletedPage } from '@/lib/use-page-mutations';
import { PageHeader } from './page-header';
import { PageContent } from './page-content';
import { PageComments } from '@/components/page-comments';

interface PageViewProps {
  path: string;
}

export function PageView({ path }: PageViewProps) {
  const router = useRouter();
  const { page, isLoading, isError, error, notFound, notGranted, redirectTo, isDeleted, refetch } = usePage({ path });
  const revertMutation = useRevertDeletedPage();

  // Handle redirects
  useEffect(() => {
    if (redirectTo) {
      // Add redirectFrom query parameter to track where we came from
      const redirectUrl = `${redirectTo}?redirectFrom=${encodeURIComponent(path)}`;
      router.replace(redirectUrl);
    }
  }, [redirectTo, path, router]);

  // Loading state
  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-16">
        <Loader2 className="h-8 w-8 animate-spin text-primary" />
        <span className="ml-3 text-muted-foreground">Loading page...</span>
      </div>
    );
  }

  // Redirect in progress
  if (redirectTo) {
    return (
      <div className="flex items-center justify-center py-16">
        <Loader2 className="h-8 w-8 animate-spin text-primary" />
        <span className="ml-3 text-muted-foreground">Redirecting to {redirectTo}...</span>
      </div>
    );
  }

  // Error state
  if (isError) {
    return (
      <Alert variant="destructive">
        <AlertCircle className="h-4 w-4" />
        <AlertTitle>Error</AlertTitle>
        <AlertDescription>
          Failed to load page. {error?.message || 'Please try again later.'}
          <Button variant="outline" size="sm" className="ml-4" onClick={() => refetch()}>
            Retry
          </Button>
        </AlertDescription>
      </Alert>
    );
  }

  // Not granted (403)
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

  // Page not found (404) - show create form
  if (notFound) {
    return (
      <Card>
        <CardHeader>
          <div className="flex items-center gap-2">
            <FilePlus2 className="h-5 w-5 text-primary" />
            <CardTitle>Page Not Found</CardTitle>
          </div>
          <CardDescription>
            The page <code className="bg-muted px-2 py-0.5 rounded">{path}</code> does not exist yet.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <p className="text-muted-foreground mb-4">Would you like to create this page?</p>
          <div className="flex gap-2">
            <Button
              variant="default"
              onClick={() => {
                router.push(`/edit?path=${encodeURIComponent(path)}`);
              }}
            >
              <FilePlus2 className="h-4 w-4 mr-2" />
              Create Page
            </Button>
            <Button variant="outline" onClick={() => router.back()}>
              Go Back
            </Button>
          </div>
        </CardContent>
      </Card>
    );
  }

  // Deleted page - show trash warning
  if (page && isDeleted) {
    const handleRestore = () => {
      revertMutation.mutate(
        { page_id: page._id },
        {
          onSuccess: (restored) => {
            // The reverted page is back at its original (non-/trash) path.
            router.replace(restored.path);
          },
        },
      );
    };

    return (
      <div className="space-y-4">
        <Alert className="border-red-200 dark:border-red-800 bg-red-50 dark:bg-red-900/20">
          <Trash2 className="h-4 w-4 text-red-500" />
          <AlertTitle className="text-red-700 dark:text-red-400">This page has been deleted</AlertTitle>
          <AlertDescription className="text-red-600 dark:text-red-300">
            This page is in the trash. You can restore it or view its contents below.
            <div className="mt-3">
              <Button
                variant="outline"
                size="sm"
                className="border-red-300 text-red-700 hover:bg-red-100 dark:border-red-700 dark:text-red-400 dark:hover:bg-red-900/40"
                onClick={handleRestore}
                disabled={revertMutation.isPending}
              >
                {revertMutation.isPending ? (
                  <>
                    <Loader2 className="h-4 w-4 mr-1 animate-spin" />
                    Restoring...
                  </>
                ) : (
                  'Restore Page'
                )}
              </Button>
              {revertMutation.isError && revertMutation.error instanceof Error && (
                <p className="mt-2 text-sm text-red-700 dark:text-red-400" role="alert">
                  {revertMutation.error.message}
                </p>
              )}
            </div>
          </AlertDescription>
        </Alert>

        <Card className="opacity-75">
          <CardContent className="pt-6">
            <PageHeader page={page} />
            <PageContent page={page} />
          </CardContent>
        </Card>
      </div>
    );
  }

  // Normal page view
  if (page) {
    return (
      <Card>
        <CardContent className="pt-6">
          <PageHeader
            page={page}
            onEdit={() => {
              router.push(`/edit?page_id=${encodeURIComponent(page._id)}`);
            }}
            showDelete
          />
          <PageContent page={page} />
          <PageComments page={page} />
        </CardContent>
      </Card>
    );
  }

  // Fallback - should not reach here
  return null;
}
