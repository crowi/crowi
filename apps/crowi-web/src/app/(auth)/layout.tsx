'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { LogOut, Settings } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useAuth } from '@/lib/use-auth';
import { ConnectionBanner } from '@/components/connection-banner';
import { ServerErrorModal } from '@/components/server-error-modal';
import { useConnection } from '@/lib/connection-context';

export default function AuthLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const router = useRouter();
  const { isLoading, isAuthenticated, logout } = useAuth();
  const { state: connectionState } = useConnection();

  useEffect(() => {
    // 接続エラー中はリダイレクトしない
    if (!isLoading && !isAuthenticated && connectionState === 'connected') {
      router.push('/login');
    }
  }, [isLoading, isAuthenticated, connectionState, router]);

  // If not authenticated and not loading (and not in error state), don't render anything (will redirect)
  if (!isAuthenticated && connectionState === 'connected') {
    // Show minimal loading state only when we don't have a token
    return (
      <div className="min-h-screen flex items-center justify-center bg-gradient-to-br from-[var(--crowi-header)] via-[oklch(0.35_0.03_192)] to-[oklch(0.4_0.04_170)]">
        <div className="text-white text-lg">Loading...</div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-background">
      {/* 接続エラーバナー */}
      <ConnectionBanner />

      {/* サーバーエラーモーダル */}
      <ServerErrorModal />

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
        {children}
      </main>
    </div>
  );
}
