'use client';

import { useEffect } from 'react';
import { useRouter, usePathname, useSearchParams } from 'next/navigation';
import Link from 'next/link';
import { LogOut, Settings, Home } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Breadcrumb } from '@/components/breadcrumb';
import { useAuth } from '@/lib/use-auth';
import { PageList } from '@/components/page-list/page-list';
import { PageView } from '@/components/page-view';

export default function CatchAllPage() {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const { user, isLoading, isAuthenticated, logout } = useAuth();

  // Check if we were redirected from another page
  const redirectFrom = searchParams.get('redirectFrom');

  useEffect(() => {
    if (!isLoading && !isAuthenticated) {
      router.push('/login');
    }
  }, [isLoading, isAuthenticated, router]);

  if (isLoading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gradient-to-br from-[var(--crowi-header)] via-[oklch(0.35_0.03_192)] to-[oklch(0.4_0.04_170)]">
        <div className="text-white text-lg">Loading...</div>
      </div>
    );
  }

  if (!isAuthenticated || !user) {
    return null;
  }

  // Determine the path for the page list or page view
  // For root /, use '/'
  // For other paths, decode the pathname to handle multibyte characters
  // Next.js usePathname() returns URL-encoded paths (e.g., /%E3%83%A6%E3%83%BC%E3%82%B6%E3%83%BC)
  // We need to decode them before using with the API
  const path = pathname === '/' ? '/' : decodeURIComponent(pathname);
  const isPortalPath = path.endsWith('/');

  // Determine page title for portal views
  const getPortalTitle = (portalPath: string): string => {
    if (portalPath === '/') return 'All Pages';
    // Remove trailing slash and get last segment
    const cleanPath = portalPath.replace(/\/$/, '');
    const segments = cleanPath.split('/').filter(Boolean);
    return segments.length > 0 ? segments[segments.length - 1] : 'Pages';
  };


  return (
    <div className="min-h-screen bg-background">
      <header className="bg-[var(--crowi-header)] text-white">
        <div className="max-w-4xl mx-auto px-4 py-4 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <Link href="/" className="flex items-center gap-2 hover:opacity-80 transition-opacity">
              <img
                src="/logo/500w-inverse.png"
                alt="Crowi"
                className="h-6 w-auto"
              />
            </Link>
          </div>
          <div className="flex items-center gap-2">
            <Button
              variant="ghost"
              size="sm"
              asChild
              className="text-white hover:bg-white/10"
            >
              <Link href="/">
                <Home className="h-4 w-4 mr-2" />
                Home
              </Link>
            </Button>
            <Button
              variant="ghost"
              size="sm"
              asChild
              className="text-white hover:bg-white/10"
            >
              <Link href="/settings">
                <Settings className="h-4 w-4 mr-2" />
                Settings
              </Link>
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={logout}
              className="text-white hover:bg-white/10"
            >
              <LogOut className="h-4 w-4 mr-2" />
              Logout
            </Button>
          </div>
        </div>
      </header>

      <main className="max-w-4xl mx-auto px-4 py-8">
        {/* Show redirect notice if we came from a redirected page */}
        {redirectFrom && (
          <Alert className="mb-6">
            <AlertDescription>
              Redirected from <code className="bg-muted px-2 py-0.5 rounded">{redirectFrom}</code>
            </AlertDescription>
          </Alert>
        )}

        {isPortalPath ? (
          // Portal/Directory view - shows page list
          <>
            <div className="mb-6">
              <Breadcrumb path={path} />
              <h1 className="text-3xl font-bold">{getPortalTitle(path)}</h1>
              <p className="text-muted-foreground mt-1">{path}</p>
            </div>
            <PageList initialParams={{ path }} />
          </>
        ) : (
          // Single page view
          <PageView path={path} />
        )}
      </main>
    </div>
  );
}
