'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { LogOut } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { UserAvatar } from '@/components/user-avatar';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { useAuth } from '@/lib/use-auth';
import { useAppInfo } from '@/lib/use-app-info';
import { UserDropdownIdentity } from '@/components/user-dropdown-identity';
import { ConnectionBanner } from '@/components/connection-banner';
import { ServerErrorModal } from '@/components/server-error-modal';
import { NotificationBell } from '@/components/notification-bell';
import { useConnection } from '@/lib/connection-context';
import { LoadingSpinner } from '@/components/ui/loading-spinner';
import { AccessDeniedCard } from '@/components/ui/access-denied-card';
import { AdminSidebar } from '@/components/admin/admin-sidebar';
import { AdminBreadcrumb } from '@/components/admin/admin-breadcrumb';
import { m } from '@paraglide/messages.js';
import { LanguageMenuItems } from '@/components/language-menu-items';
import { UserMenuItems } from '@/components/user-menu-items';

export default function AdminLayout({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const { user, isLoading, isAuthenticated, logout } = useAuth();
  const { state: connectionState } = useConnection();
  const { data: appInfo } = useAppInfo();

  useEffect(() => {
    // 接続エラー中はリダイレクトしない
    if (!isLoading && !isAuthenticated && connectionState === 'connected') {
      router.push('/login');
    }
  }, [isLoading, isAuthenticated, connectionState, router]);

  // セッション期限切れイベントのリスナー
  useEffect(() => {
    const handleSessionExpired = () => {
      router.push('/login');
    };

    window.addEventListener('auth:session-expired', handleSessionExpired);
    return () => window.removeEventListener('auth:session-expired', handleSessionExpired);
  }, [router]);

  // 認証チェック中、または接続正常時の未認証の場合はローディング画面を表示
  if (!isAuthenticated && (isLoading || connectionState === 'connected')) {
    // Intentionally locale-agnostic: this Client Component is SSR-rendered
    // before hydration and Paraglide's getLocale() is bound to a different
    // runtime instance there than in Server Components, so any localised
    // string here would mismatch and trip hydration.
    return (
      <div className="min-h-screen flex items-center justify-center bg-gradient-to-br from-[var(--crowi-header)] via-[oklch(0.35_0.03_192)] to-[oklch(0.4_0.04_170)]">
        <div className="text-white text-lg">Loading...</div>
      </div>
    );
  }

  // user 取得中 (isAuthenticated ではあるが user がまだ null) のローディング
  if (!user) {
    return (
      <div className="min-h-screen bg-background">
        <ConnectionBanner />
        <ServerErrorModal />
        <main className="max-w-6xl mx-auto px-4 py-8">
          <LoadingSpinner />
        </main>
      </div>
    );
  }

  // admin チェック: 認証済だが admin ではない場合は AccessDeniedCard を表示
  if (!user.admin) {
    return (
      <div className="min-h-screen bg-background">
        <ConnectionBanner />
        <ServerErrorModal />
        <main className="max-w-2xl mx-auto px-4 py-8">
          <AccessDeniedCard
            title={m['admin.access_denied_title']()}
            description={m['admin.access_denied_description']()}
            body={m['admin.access_denied_body']()}
            onGoBack={() => router.back()}
          />
        </main>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-background">
      <ConnectionBanner />
      <ServerErrorModal />

      <header className="crowi-top-border bg-background text-foreground shadow-header relative z-40">
        <div className="max-w-7xl mx-auto px-4 py-3 flex items-center justify-between">
          <div className="flex items-center gap-3 min-w-0">
            <Link
              href="/"
              className="flex items-center gap-2 text-foreground hover:opacity-80 transition-opacity min-w-0"
              aria-label={appInfo?.title ?? 'Crowi'}
            >
              {appInfo?.title ? (
                <>
                  <img src="/logo/icon.png" alt="" className="h-6 w-6 shrink-0" />
                  <span className="text-base font-semibold truncate text-primary">{appInfo.title}</span>
                </>
              ) : (
                <img src="/logo/500w.png" alt="Crowi" className="h-6 w-auto shrink-0" />
              )}
            </Link>
            <span className="hidden sm:inline rounded bg-primary/10 text-primary px-2 py-0.5 text-xs font-semibold uppercase tracking-wide shrink-0">
              Admin
            </span>
          </div>
          <div className="flex items-center gap-2">
            <NotificationBell />
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="ghost" size="sm" className="hover:bg-muted flex items-center gap-2 px-1.5">
                  <UserAvatar user={user} size="sm" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-64">
                <UserDropdownIdentity user={user} />
                <DropdownMenuSeparator />
                <UserMenuItems username={user.username} />
                <LanguageMenuItems />
                <DropdownMenuSeparator />
                <DropdownMenuItem onClick={logout} className="text-destructive">
                  <LogOut className="h-4 w-4 mr-2" />
                  {m['header.user_dropdown_logout']()}
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </div>
      </header>

      <div className="max-w-7xl mx-auto px-4 py-8 grid grid-cols-1 gap-8 lg:grid-cols-[16rem_1fr]">
        <aside className="lg:sticky lg:top-8 lg:self-start">
          <AdminSidebar />
        </aside>
        <main>
          <AdminBreadcrumb />
          {children}
        </main>
      </div>
    </div>
  );
}
