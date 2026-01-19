'use client';

import { User, Bell, Shield, Settings as SettingsIcon } from 'lucide-react';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';

interface SettingsLayoutProps {
  profileTab: React.ReactNode;
}

export function SettingsLayout({ profileTab }: SettingsLayoutProps) {
  return (
    <div className="container max-w-4xl mx-auto py-8 px-4">
      <div className="mb-8">
        <h1 className="text-3xl font-bold flex items-center gap-2">
          <SettingsIcon className="size-8" />
          設定
        </h1>
        <p className="text-muted-foreground mt-2">
          アカウント設定とプロフィールを管理
        </p>
      </div>

      <Tabs defaultValue="profile" className="space-y-6">
        <TabsList className="w-full justify-start">
          <TabsTrigger value="profile" className="flex items-center gap-2">
            <User className="size-4" />
            プロフィール
          </TabsTrigger>
          <TabsTrigger
            value="notifications"
            className="flex items-center gap-2"
            disabled
          >
            <Bell className="size-4" />
            通知
          </TabsTrigger>
          <TabsTrigger value="security" className="flex items-center gap-2" disabled>
            <Shield className="size-4" />
            セキュリティ
          </TabsTrigger>
        </TabsList>

        <TabsContent value="profile" className="space-y-6">
          {profileTab}
        </TabsContent>

        <TabsContent value="notifications">
          <Card>
            <CardHeader>
              <CardTitle>通知設定</CardTitle>
              <CardDescription>
                通知の受信方法を設定します（近日公開予定）
              </CardDescription>
            </CardHeader>
            <CardContent>
              <p className="text-muted-foreground">この機能は開発中です。</p>
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="security">
          <Card>
            <CardHeader>
              <CardTitle>セキュリティ設定</CardTitle>
              <CardDescription>
                パスワードとセキュリティ設定を管理します（近日公開予定）
              </CardDescription>
            </CardHeader>
            <CardContent>
              <p className="text-muted-foreground">この機能は開発中です。</p>
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>
    </div>
  );
}
