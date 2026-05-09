'use client';

import { User, Shield, Settings as SettingsIcon } from 'lucide-react';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';

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
          <TabsTrigger value="security" className="flex items-center gap-2">
            <Shield className="size-4" />
            セキュリティ
          </TabsTrigger>
        </TabsList>

        <TabsContent value="profile" className="space-y-6">
          {profileTab}
        </TabsContent>

        <TabsContent value="security" className="space-y-6">
          {securityTab}
        </TabsContent>
      </Tabs>
    </>
  );
}
