'use client';

import { User, Bell, Shield, Settings as SettingsIcon } from 'lucide-react';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';

interface SettingsLayoutProps {
  profileTab: React.ReactNode;
  securityTab?: React.ReactNode;
}

export function SettingsLayout({ profileTab, securityTab }: SettingsLayoutProps) {
  return (
    <>
      <div className="mb-8">
        <h1 className="text-3xl font-bold flex items-center gap-2">
          <SettingsIcon className="size-8" />
          設定
        </h1>
        <p className="text-muted-foreground mt-2">アカウント設定とプロフィールを管理</p>
      </div>

      <Tabs defaultValue="profile" className="space-y-6">
        <TabsList className="w-full justify-start">
          <TabsTrigger value="profile" className="flex items-center gap-2">
            <User className="size-4" />
            プロフィール
          </TabsTrigger>
          <TabsTrigger value="notifications" className="flex items-center gap-2" disabled>
            <Bell className="size-4" />
            通知
          </TabsTrigger>
          <TabsTrigger value="security" className="flex items-center gap-2">
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
              <CardDescription>通知の受信方法を設定します（近日公開予定）</CardDescription>
            </CardHeader>
            <CardContent>
              <p className="text-muted-foreground">この機能は開発中です。</p>
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="security" className="space-y-6">
          {securityTab}
        </TabsContent>
      </Tabs>
    </>
  );
}
