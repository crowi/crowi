'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { LogOut } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { UserAvatar } from '@/components/user-avatar';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { useAuth } from '@/lib/use-auth';
import { ConnectionBanner } from '@/components/connection-banner';
import { ServerErrorModal } from '@/components/server-error-modal';
import { NotificationBell } from '@/components/notification-bell';
import { useConnection } from '@/lib/connection-context';
import { m } from '@paraglide/messages.js';
import { UserMenuItems } from '@/components/user-menu-items';
import { UserDropdownIdentity } from '@/components/user-dropdown-identity';
import { SiteBrand } from '@/components/site-brand';
import { LocaleSync } from '@/components/locale-sync';
import { buildLoginRedirectUrl } from '@/lib/login-redirect';
import { GlobalSearchInput } from '@/components/search/global-search-input';
import { Toaster } from '@/components/ui/sonner';

export default function AuthLayout({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const { user, isLoading, isAuthenticated, logout } = useAuth();
  const { state: connectionState } = useConnection();

  useEffect(() => {
    // 接続エラー中はリダイレクトしない
    if (!isLoading && !isAuthenticated && connectionState === 'connected') {
      router.push(buildLoginRedirectUrl(window.location.pathname + window.location.search));
    }
  }, [isLoading, isAuthenticated, connectionState, router]);

  // セッション期限切れイベントのリスナー
  useEffect(() => {
    const handleSessionExpired = () => {
      router.push(buildLoginRedirectUrl(window.location.pathname + window.location.search));
    };

    window.addEventListener('auth:session-expired', handleSessionExpired);
    return () => window.removeEventListener('auth:session-expired', handleSessionExpired);
  }, [router]);

  // 認証チェック中、または接続正常時の未認証の場合はローディング画面を表示
  // 接続エラー時は下のレイアウト(エラーバナー/モーダル付き)を表示
  if (!isAuthenticated && (isLoading || connectionState === 'connected')) {
    // Intentionally locale-agnostic: this Client Component is SSR-rendered
    // before hydration and Paraglide's getLocale() is bound to a different
    // runtime instance there than in Server Components, so any localised
    // string here would mismatch and trip hydration. The full layout below
    // (which renders after hydration) uses the proper m['*']() lookups.
    return (
      <div className="min-h-screen flex items-center justify-center bg-gradient-to-br from-[var(--crowi-header)] via-[oklch(0.35_0.03_192)] to-[oklch(0.4_0.04_170)]">
        <div className="text-white text-lg">Loading...</div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-background">
      <LocaleSync />
      {/* 接続エラーバナー */}
      <ConnectionBanner />

      {/* サーバーエラーモーダル */}
      <ServerErrorModal />

      <header className="crowi-top-border bg-background text-foreground shadow-header relative z-40">
        <div className="max-w-4xl mx-auto px-4 py-3 flex items-center gap-4">
          <div className="flex items-center gap-3 min-w-0 shrink-0">
            <SiteBrand />
          </div>
          <GlobalSearchInput />
          <div className="flex items-center gap-2 ml-auto">
            <NotificationBell />
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  variant="ghost"
                  size="sm"
                  className="hover:bg-muted flex items-center gap-2 px-1.5"
                  aria-label={m['header.user_menu_aria']({ name: user?.name || user?.username || '' })}
                >
                  {user && <UserAvatar user={user} size="sm" />}
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-64">
                {user && <UserDropdownIdentity user={user} />}
                <DropdownMenuSeparator />
                {user && <UserMenuItems username={user.username} isAdmin={user.admin === true} />}
                <DropdownMenuItem onClick={logout} className="text-destructive">
                  <LogOut className="h-4 w-4 mr-2" />
                  {m['header.user_dropdown_logout']()}
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </div>
      </header>

      <main className="max-w-4xl mx-auto px-4 py-8">{children}</main>

      {/* RFC-0003 Phase 7 — single toaster instance for collab connection
          status notifications (offline / reconnected / auth-failed).
          Mounted at the (auth) shell level so a child-page rerender
          inside /_edit doesn't unmount the toast container and drop
          in-flight notifications. */}
      <Toaster />
    </div>
  );
}
