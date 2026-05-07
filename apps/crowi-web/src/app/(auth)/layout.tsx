'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { LogOut, Settings, Shield, User, Bookmark, FileText, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { UserAvatar } from '@/components/user-avatar';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { useAuth } from '@/lib/use-auth';
import { ConnectionBanner } from '@/components/connection-banner';
import { ServerErrorModal } from '@/components/server-error-modal';
import { NotificationBell } from '@/components/notification-bell';
import { useConnection } from '@/lib/connection-context';
import { m } from '@/paraglide/messages.js';
import { LanguageMenuItems } from '@/components/language-menu-items';

export default function AuthLayout({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const { user, isLoading, isAuthenticated, logout } = useAuth();
  const { state: connectionState } = useConnection();

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
  // 接続エラー時は下のレイアウト(エラーバナー/モーダル付き)を表示
  if (!isAuthenticated && (isLoading || connectionState === 'connected')) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gradient-to-br from-[var(--crowi-header)] via-[oklch(0.35_0.03_192)] to-[oklch(0.4_0.04_170)]">
        <div className="text-white text-lg">{m['common.loading']()}</div>
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
              <img src="/logo/500w-inverse.png" alt="Crowi" className="h-6 w-auto" />
            </Link>
          </div>
          <div className="flex items-center gap-2">
            {user?.admin && (
              <Button
                asChild
                variant="ghost"
                size="icon-sm"
                aria-label={m['header.admin_aria']()}
                title={m['header.admin_aria']()}
                className="text-white hover:bg-white/10 hover:text-white"
              >
                <Link href="/admin">
                  <Shield className="h-4 w-4" />
                </Link>
              </Button>
            )}
            <NotificationBell />
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="ghost" size="sm" className="text-white hover:bg-white/10 hover:text-white flex items-center gap-2">
                  {user && <UserAvatar user={user} size="sm" />}
                  <span className="hidden sm:inline !text-white">{user?.name || user?.username}</span>
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-56">
                <div className="px-2 py-1.5 text-sm">
                  <div className="font-medium">{user?.name}</div>
                  <div className="text-muted-foreground">@{user?.username}</div>
                </div>
                <DropdownMenuSeparator />
                <DropdownMenuItem asChild>
                  <Link href={`/user/${user?.username}`}>
                    <User className="h-4 w-4 mr-2" />
                    {m['header.user_dropdown_my_page']()}
                  </Link>
                </DropdownMenuItem>
                <DropdownMenuItem asChild>
                  <Link href={`/user/${user?.username}/bookmarks`}>
                    <Bookmark className="h-4 w-4 mr-2" />
                    {m['header.user_dropdown_bookmarks']()}
                  </Link>
                </DropdownMenuItem>
                <DropdownMenuItem asChild>
                  <Link href={`/user/${user?.username}/recent-create`}>
                    <FileText className="h-4 w-4 mr-2" />
                    {m['header.user_dropdown_created']()}
                  </Link>
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem asChild>
                  <Link href="/trash">
                    <Trash2 className="h-4 w-4 mr-2" />
                    {m['header.user_dropdown_trash']()}
                  </Link>
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem asChild>
                  <Link href="/settings">
                    <Settings className="h-4 w-4 mr-2" />
                    {m['header.user_dropdown_settings']()}
                  </Link>
                </DropdownMenuItem>
                <LanguageMenuItems />
                <DropdownMenuSeparator />
                <DropdownMenuItem onClick={logout} className="text-red-600">
                  <LogOut className="h-4 w-4 mr-2" />
                  {m['header.user_dropdown_logout']()}
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </div>
      </header>

      <main className="max-w-4xl mx-auto px-4 py-8">{children}</main>
    </div>
  );
}
