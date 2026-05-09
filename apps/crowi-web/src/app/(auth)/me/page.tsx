'use client';

import { useProfile } from '@/lib/use-profile';
import { SettingsLayout } from './settings-layout';
import { ProfileForm } from './profile-form';
import { ProfilePicture } from './profile-picture';
import { PasswordForm } from './password-form';
import { ApiTokenSection } from './api-token-section';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';

export default function SettingsPage() {
  const { data: profile, isLoading, error } = useProfile();

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="text-center space-y-4">
          <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-primary mx-auto" />
          <p className="text-muted-foreground">読み込み中...</p>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <Alert variant="destructive">
        <AlertDescription>プロフィールの読み込みに失敗しました。ログインしていることを確認してください。</AlertDescription>
      </Alert>
    );
  }

  if (!profile) {
    return (
      <Alert variant="destructive">
        <AlertDescription>プロフィールが見つかりませんでした。</AlertDescription>
      </Alert>
    );
  }

  return (
    <SettingsLayout
      profileTab={
        <div className="space-y-6">
          <Card>
            <CardHeader>
              <CardTitle>プロフィール画像</CardTitle>
              <CardDescription>あなたのプロフィール画像を変更できます</CardDescription>
            </CardHeader>
            <CardContent>
              <ProfilePicture profile={profile} />
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>基本情報</CardTitle>
              <CardDescription>名前、メールアドレス、言語設定を変更できます</CardDescription>
            </CardHeader>
            <CardContent>
              <ProfileForm profile={profile} />
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>アカウント情報</CardTitle>
              <CardDescription>作成日時とアカウントID</CardDescription>
            </CardHeader>
            <CardContent className="space-y-2">
              <div className="grid grid-cols-2 gap-4 text-sm">
                <div>
                  <p className="text-muted-foreground">アカウントID</p>
                  <p className="font-mono">{profile.id}</p>
                </div>
                <div>
                  <p className="text-muted-foreground">作成日時</p>
                  <p>{new Date(profile.createdAt).toLocaleString('ja-JP')}</p>
                </div>
              </div>
            </CardContent>
          </Card>
        </div>
      }
      securityTab={
        <div className="space-y-6">
          <Card>
            <CardHeader>
              <CardTitle>パスワード変更</CardTitle>
              <CardDescription>アカウントのパスワードを変更できます</CardDescription>
            </CardHeader>
            <CardContent>
              <PasswordForm profile={profile} />
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>APIトークン</CardTitle>
              <CardDescription>API経由でCrowiにアクセスするためのトークンを管理します</CardDescription>
            </CardHeader>
            <CardContent>
              <ApiTokenSection />
            </CardContent>
          </Card>
        </div>
      }
    />
  );
}
