'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { LogOut, Settings, User, Bookmark, FileText, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Avatar, AvatarImage, AvatarFallback } from '@/components/ui/avatar';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { useAuth } from '@/lib/use-auth';

export default function AuthLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const router = useRouter();
  const { user, isLoading, isAuthenticated, logout } = useAuth();

  useEffect(() => {
    if (!isLoading && !isAuthenticated) {
      router.push('/login');
    }
  }, [isLoading, isAuthenticated, router]);

  // If not authenticated and not loading, don't render anything (will redirect)
  if (!isAuthenticated) {
    // Show minimal loading state only when we don't have a token
    return (
      <div className="min-h-screen flex items-center justify-center bg-gradient-to-br from-[var(--crowi-header)] via-[oklch(0.35_0.03_192)] to-[oklch(0.4_0.04_170)]">
        <div className="text-white text-lg">Loading...</div>
      </div>
    );
  }

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
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  variant="ghost"
                  size="sm"
                  className="text-white hover:bg-white/10 flex items-center gap-2"
                >
                  <Avatar className="h-6 w-6">
                    {user?.image ? (
                      <AvatarImage src={user.image} alt={user.name || user.username} />
                    ) : null}
                    <AvatarFallback className="bg-[var(--crowi-primary)] text-white text-xs">
                      {(user?.name || user?.username || '?').charAt(0).toUpperCase()}
                    </AvatarFallback>
                  </Avatar>
                  <span className="hidden sm:inline">{user?.name || user?.username}</span>
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
                    マイページ
                  </Link>
                </DropdownMenuItem>
                <DropdownMenuItem asChild>
                  <Link href={`/user/${user?.username}/bookmarks`}>
                    <Bookmark className="h-4 w-4 mr-2" />
                    ブックマーク
                  </Link>
                </DropdownMenuItem>
                <DropdownMenuItem asChild>
                  <Link href={`/user/${user?.username}/recent-create`}>
                    <FileText className="h-4 w-4 mr-2" />
                    作成したページ
                  </Link>
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem asChild>
                  <Link href="/trash">
                    <Trash2 className="h-4 w-4 mr-2" />
                    ゴミ箱
                  </Link>
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem asChild>
                  <Link href="/settings">
                    <Settings className="h-4 w-4 mr-2" />
                    設定
                  </Link>
                </DropdownMenuItem>
                <DropdownMenuItem onClick={logout} className="text-red-600">
                  <LogOut className="h-4 w-4 mr-2" />
                  ログアウト
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </div>
      </header>

      <main className="max-w-4xl mx-auto px-4 py-8">
        {children}
      </main>
    </div>
  );
}
