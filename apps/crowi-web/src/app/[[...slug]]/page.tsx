'use client';

import { useEffect } from 'react';
import { useRouter, usePathname } from 'next/navigation';
import Link from 'next/link';
import { LogOut, Settings } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useAuth } from '@/lib/use-auth';
import { PageList } from '@/components/page-list/page-list';

export default function CatchAllPage() {
  const router = useRouter();
  const pathname = usePathname();
  const { user, isLoading, isAuthenticated, logout } = useAuth();

  useEffect(() => {
    if (!isLoading && !isAuthenticated) {
      router.push('/login');
    }
  }, [isLoading, isAuthenticated, router]);

  if (isLoading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gradient-to-br from-[var(--crowi-header)] via-[oklch(0.35_0.03_192)] to-[oklch(0.4_0.04_170)]">
        <div className="text-white text-lg">読み込み中...</div>
      </div>
    );
  }

  if (!isAuthenticated || !user) {
    return null;
  }

  // Determine the path for the page list
  // For root /, use '/'
  // For other paths, use as-is
  const path = pathname === '/' ? '/' : pathname;
  const isPortalPath = path.endsWith('/');

  return (
    <div className="min-h-screen bg-background">
      <header className="bg-[var(--crowi-header)] text-white">
        <div className="max-w-4xl mx-auto px-4 py-4 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <img
              src="/logo/500w-inverse.png"
              alt="Crowi"
              className="h-6 w-auto"
            />
          </div>
          <div className="flex items-center gap-2">
            <Button
              variant="ghost"
              size="sm"
              asChild
              className="text-white hover:bg-white/10"
            >
              <Link href="/settings">
                <Settings className="h-4 w-4 mr-2" />
                設定
              </Link>
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={logout}
              className="text-white hover:bg-white/10"
            >
              <LogOut className="h-4 w-4 mr-2" />
              ログアウト
            </Button>
          </div>
        </div>
      </header>

      <main className="max-w-4xl mx-auto px-4 py-8">
        <div className="mb-6">
          <h1 className="text-3xl font-bold">
            {path === '/' ? 'All Pages' : `Pages: ${path}`}
          </h1>
          <p className="text-muted-foreground mt-1">
            {isPortalPath
              ? 'Browse pages in this directory'
              : 'Page view'}
          </p>
        </div>

        {isPortalPath ? (
          <PageList initialParams={{ path }} />
        ) : (
          <div className="bg-yellow-50 dark:bg-yellow-900/20 border border-yellow-200 dark:border-yellow-800 rounded-lg p-6">
            <h2 className="text-lg font-semibold mb-2">Page View Not Implemented</h2>
            <p className="text-muted-foreground mb-4">
              Single page view is not yet implemented. This will show the page content for: <code className="bg-black/10 dark:bg-white/10 px-2 py-1 rounded">{path}</code>
            </p>
            <p className="text-sm text-muted-foreground">
              For now, you can view the page list by adding a trailing slash: <Link href={`${path}/`} className="text-primary hover:underline">{path}/</Link>
            </p>
          </div>
        )}
      </main>
    </div>
  );
}
