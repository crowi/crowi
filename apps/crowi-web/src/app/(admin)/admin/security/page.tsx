'use client';

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { LoadingSpinner } from '@/components/ui/loading-spinner';
import { useAdminSecuritySettings } from '@/lib/use-admin-security';
import { SecurityForm } from './security-form';

/**
 * /admin/security
 *
 * Manages the four legacy `security:*` config keys: basicName, basicSecret,
 * registrationMode, registrationWhiteList. Authorization (admin only) is
 * already enforced by the surrounding (admin) layout, so this page assumes
 * the current user is admin and only handles fetch / form state.
 */
export default function AdminSecurityPage() {
  const { data, isLoading, error } = useAdminSecuritySettings();

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">セキュリティ</h1>
        <p className="text-muted-foreground mt-1 text-sm">新規ユーザーの登録ポリシーや Basic 認証など、サイト全体のセキュリティ設定を管理します。</p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>セキュリティ設定</CardTitle>
          <CardDescription>登録モードと Basic 認証の設定を変更します。</CardDescription>
        </CardHeader>
        <CardContent>
          {isLoading && <LoadingSpinner />}

          {!isLoading && error && (
            <Alert variant="destructive">
              <AlertDescription>{error instanceof Error ? error.message : 'セキュリティ設定の取得に失敗しました'}</AlertDescription>
            </Alert>
          )}

          {!isLoading && !error && data && <SecurityForm settings={data} />}
        </CardContent>
      </Card>
    </div>
  );
}
