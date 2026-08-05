'use client';

import { useEffect } from 'react';
import { usePathname, useRouter } from 'next/navigation';
import { LogOut } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { UserAvatar } from '@/components/user-avatar';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { useAuth } from '@/lib/use-auth';
import { ConnectionBanner } from '@/components/connection-banner';
import { ServerErrorModal } from '@/components/server-error-modal';
import { NotificationBell } from '@/components/notification-bell';
import { CreatePageButton } from '@/components/create-page/create-page-dialog';
import { useNotificationsSocket } from '@/lib/use-notifications-socket';
import { useConnection } from '@/lib/connection-context';
import { isReauthSuppressed, useReauthSuppressed } from '@/lib/session-reauth-context';
import { m } from '@paraglide/messages.js';
import { UserMenuItems } from '@/components/user-menu-items';
import { UserDropdownIdentity } from '@/components/user-dropdown-identity';
import { SiteBrand } from '@/components/site-brand';
import { LocaleSync } from '@/components/locale-sync';
import { ThemeSync } from '@/components/theme-sync';
import { RendererStylesheets } from '@/components/renderer-stylesheets';
import { buildLoginRedirectUrl } from '@/lib/login-redirect';
import { ConfidentialNotice } from '@/components/confidential-notice';
import { SearchFocusProvider } from '@/lib/search-focus-context';
import { GlobalSearchInput } from '@/components/search/global-search-input';
import { MobileSearch } from '@/components/search/mobile-search';
import { PageSidebar } from '@/components/page-sidebar/page-sidebar';
import { PluginReadinessBanner } from '@/components/admin/plugin-readiness-banner';
import { decodePagePathFromUrl } from '@/lib/page-path';
import { Toaster } from '@/components/ui/sonner';
import { MAX_VISIBLE_TOASTS } from '@/lib/notify';
import { MAIN_CONTENT_ID, useRouteFocus } from '@/lib/use-route-focus';
import { SkipLink } from '@/components/skip-link';

// Routes whose nested layout escapes the centred column to fill the
// viewport (`w-screen`); the fixed left rail would overlap them, so the
// sidebar is suppressed there.
const FULL_BLEED_PREFIXES = ['/_edit', '/_history'];

export default function AuthLayout({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const pathname = usePathname();
  const { user, isLoading, isAuthenticated, logout } = useAuth();
  const { state: connectionState } = useConnection();

  // The page sidebar lives at the (auth) shell level so its shared nav
  // links show on every page, not just wiki pages — it only collapses
  // its hierarchy tree on non-wiki routes (see PageSidebar). Full-bleed
  // routes (editor / history) opt out entirely.
  const sidebarPath = pathname === '/' ? '/' : decodePagePathFromUrl(pathname);
  const showSidebar = !FULL_BLEED_PREFIXES.some((p) => pathname === p || pathname.startsWith(`${p}/`));
  // While an inline-reauth-capable editor is mounted (or its modal is
  // open), both redirect routes below are suppressed so a session expiry
  // doesn't navigate away and throw the Y.Doc buffer out. The signal is
  // module-level because `SessionReauthProvider` is a *descendant* of
  // this layout, so a React Context can't flow upward — see
  // `session-reauth-context.tsx`. Outside the editor it is always
  // `false` and redirects run as before.
  const reauthSuppressed = useReauthSuppressed();

  // Realtime notification invalidation. The hook is idle until auth
  // resolves (`enabled: isAuthenticated`) so the unauthed login screen
  // does not blast `/notifications/token` at the server. Mounted once
  // here so the entire (auth) shell — including NotificationBell —
  // shares one WebSocket per tab, not one per render scope.
  useNotificationsSocket({ enabled: isAuthenticated });

  // Moves focus to `#main-content` on every client-side route change
  // (skips the first mount) — see use-route-focus.ts.
  useRouteFocus();

  useEffect(() => {
    // 接続エラー中、またはエディタの再認証中はリダイレクトしない
    if (!isLoading && !isAuthenticated && connectionState === 'connected' && !reauthSuppressed) {
      router.push(buildLoginRedirectUrl(window.location.pathname + window.location.search));
    }
  }, [isLoading, isAuthenticated, connectionState, router, reauthSuppressed]);

  // セッション期限切れイベントのリスナー
  useEffect(() => {
    const handleSessionExpired = () => {
      // エディタ(再認証 provider 配下)では、このイベントはインラインモーダル
      // が処理するのでリダイレクトしない。このリスナーは ancestor として先に
      // 登録され provider のハンドラより先に走るため、React state ではなく
      // ハンドラ実行時点のモジュールフラグ(provider マウント有無)を直接読む。
      if (isReauthSuppressed()) return;
      router.push(buildLoginRedirectUrl(window.location.pathname + window.location.search));
    };

    window.addEventListener('auth:session-expired', handleSessionExpired);
    return () => window.removeEventListener('auth:session-expired', handleSessionExpired);
  }, [router]);

  // 認証チェック中、または接続正常時の未認証の場合はローディング画面を表示
  // 接続エラー時は下のレイアウト(エラーバナー/モーダル付き)を表示。
  // ただしエディタ再認証中は children(= Y.Doc を持つエディタ)を unmount
  // させないため、このローディング画面に切り替えない。
  if (!isAuthenticated && (isLoading || connectionState === 'connected') && !reauthSuppressed) {
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

  // `overflow-x-clip`: the page view escapes the centred column with a
  // `w-screen` group (see PageView). `100vw` is wider than the content
  // box by the scrollbar width, so without clipping the right edge a
  // few px of horizontal scroll would appear. `clip` (not `hidden`)
  // avoids creating a scroll container, so `position: sticky` (TOC
  // rail) and `position: fixed` (compact header) stay viewport-relative.
  return (
    <div className="min-h-screen bg-background overflow-x-clip">
      <LocaleSync />
      <ThemeSync />
      <RendererStylesheets />
      {/* 接続エラーバナー */}
      <ConnectionBanner />

      {/* サーバーエラーモーダル */}
      <ServerErrorModal />

      <SkipLink />

      <SearchFocusProvider>
        <header className="crowi-top-border bg-background text-foreground shadow-header dark:shadow-none dark:border-b dark:border-border relative z-40">
          <div className="max-w-4xl mx-auto px-4 py-3 flex items-center gap-4">
            <div className="flex items-center gap-1 min-w-0 shrink-0">
              <SiteBrand />
              {/* Mobile (< md) search trigger next to the logo — the desktop
                search input below is hidden on narrow viewports. */}
              <MobileSearch />
            </div>
            <GlobalSearchInput />
            <div className="flex items-center gap-2 ml-auto">
              {/* 機密注意書き — app:confidential 設定時に常時表示。スクショ/
                印刷で機密文書と分かるよう右クラスタ先頭に控えめに出す。 */}
              <ConfidentialNotice />
              <CreatePageButton />
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
      </SearchFocusProvider>

      {/* プラグイン設定準備状況バナー — 管理者が active driver の必須設定 (S3
          bucket / 検索 driver の url 等) を未設定のまま使っている場合だけ、
          ヘッダー直下・本文より上に表示する (feature-plugin-config-readiness)。 */}
      <PluginReadinessBanner isAdmin={user?.admin === true} containerClassName="max-w-4xl mx-auto" />

      {/* 機密注意書き(モバイル) — 右クラスタに余地がない < sm では、ヘッダー
          直下の細い行で全文を表示し、どのビューポートでも機密マーカーが
          スクショ/印刷に残るようにする。 */}
      <ConfidentialNotice placement="bar" />

      {/*
        Page-grant accent strip — a thin horizontal bar directly
        under the header that picks up `--page-grant-accent`
        (transparent for PUBLIC, dark gray for OWNER/SPECIFIED, dark
        purple for RESTRICTED). Peripheral signal of the page's
        privacy level without tinting any surface that has content
        on it. Non-sticky on purpose: the sticky compact page header
        carries its own lock-icon affordance once you scroll.
      */}
      <div aria-hidden className="h-1 transition-colors" style={{ backgroundColor: 'var(--page-grant-accent)' }} />

      <main
        id={MAIN_CONTENT_ID}
        tabIndex={-1}
        className="max-w-4xl mx-auto px-4 py-8 focus:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
      >
        {children}
      </main>

      {showSidebar && <PageSidebar path={sidebarPath} />}

      {/* RFC-0003 Phase 7 — single toaster instance for collab connection
          status notifications (offline / reconnected / auth-failed).
          Mounted at the (auth) shell level so a child-page rerender
          inside /_edit doesn't unmount the toast container and drop
          in-flight notifications.

          RFC-0004 Phase 1 — also the host for the shared `notify`
          utility (lib/notify.ts). `visibleToasts` caps the stack at 5
          so older toasts fade first when newer ones arrive. */}
      <Toaster visibleToasts={MAX_VISIBLE_TOASTS} />
    </div>
  );
}
