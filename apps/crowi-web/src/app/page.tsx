'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { LogOut, User, Mail, AtSign, Calendar } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { useAuth } from '@/lib/use-auth';

export default function Home() {
  const router = useRouter();
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

  return (
    <div className="min-h-screen bg-background">
      <header className="bg-[var(--crowi-header)] text-white">
        <div className="max-w-4xl mx-auto px-4 py-4 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <img
              src="/logo/100w-inverse.png"
              width={80}
              alt="Crowi"
              className="h-8 w-auto"
            />
          </div>
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
      </header>

      <main className="max-w-4xl mx-auto px-4 py-8">
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <User className="h-5 w-5" />
              ユーザー情報
            </CardTitle>
            <CardDescription>現在ログイン中のユーザー</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="flex items-center gap-3">
              {user.image ? (
                <img
                  src={user.image}
                  alt={user.name}
                  className="w-16 h-16 rounded-full"
                />
              ) : (
                <div className="w-16 h-16 rounded-full bg-primary flex items-center justify-center text-primary-foreground text-xl font-semibold">
                  {user.name.charAt(0).toUpperCase()}
                </div>
              )}
              <div>
                <h2 className="text-xl font-semibold">{user.name}</h2>
                <p className="text-muted-foreground flex items-center gap-1">
                  <AtSign className="h-4 w-4" />
                  {user.username}
                </p>
              </div>
            </div>

            <div className="grid gap-3 pt-4 border-t">
              <div className="flex items-center gap-2 text-sm">
                <Mail className="h-4 w-4 text-muted-foreground" />
                <span className="text-muted-foreground">メール:</span>
                <span>{user.email}</span>
              </div>
              <div className="flex items-center gap-2 text-sm">
                <Calendar className="h-4 w-4 text-muted-foreground" />
                <span className="text-muted-foreground">登録日:</span>
                <span>{new Date(user.createdAt).toLocaleDateString('ja-JP')}</span>
              </div>
            </div>
          </CardContent>
        </Card>
      </main>
    </div>
  );
}
