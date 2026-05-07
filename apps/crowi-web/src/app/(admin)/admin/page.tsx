'use client';

import Link from 'next/link';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { ADMIN_NAV_GROUPS } from '@/components/admin/admin-sidebar';
import { CryptoStatusCard } from '@/components/admin/crypto-status-card';

export default function AdminIndexPage() {
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">管理ダッシュボード</h1>
        <p className="text-muted-foreground mt-1 text-sm">Crowi の管理者向け機能の一覧です。各セクションは順次実装予定です。</p>
      </div>

      <CryptoStatusCard />

      <div className="space-y-8">
        {ADMIN_NAV_GROUPS.map((group) => (
          <section key={group.heading} className="space-y-3">
            <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">{group.heading}</h2>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {group.items.map((item) => {
                const Icon = item.icon;
                const isAvailable = item.status === 'available';
                return (
                  <Link
                    key={item.href}
                    href={item.href}
                    className="block transition-transform hover:-translate-y-0.5 focus:outline-none focus-visible:ring-2 focus-visible:ring-primary"
                  >
                    <Card className="h-full transition-shadow hover:shadow-md">
                      <CardHeader>
                        <div className="flex items-center gap-2">
                          <Icon className="h-5 w-5 text-primary" />
                          <CardTitle className="text-base">{item.label}</CardTitle>
                        </div>
                        {isAvailable ? (
                          item.description && <CardDescription>{item.description}</CardDescription>
                        ) : (
                          <CardDescription>Coming soon</CardDescription>
                        )}
                      </CardHeader>
                      {!isAvailable && (
                        <CardContent>
                          <p className="text-muted-foreground text-sm">この機能は開発中です。</p>
                        </CardContent>
                      )}
                    </Card>
                  </Link>
                );
              })}
            </div>
          </section>
        ))}
      </div>
    </div>
  );
}
