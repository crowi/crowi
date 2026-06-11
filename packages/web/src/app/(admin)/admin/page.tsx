'use client';

import { Suspense } from 'react';
import Link from 'next/link';
import { Card, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { ADMIN_NAV_GROUPS } from '@/components/admin/admin-sidebar';
import { CryptoStatusCard } from '@/components/admin/crypto-status-card';
import { SetupChecklist } from '@/components/admin/setup-checklist';
import { WelcomeDialog } from '@/components/admin/welcome-dialog';
import { m } from '@paraglide/messages.js';

export default function AdminIndexPage() {
  return (
    <div className="space-y-6">
      {/* `WelcomeDialog` reads `?welcome=installed` via useSearchParams,
          which needs a Suspense boundary in the App Router. */}
      <Suspense fallback={null}>
        <WelcomeDialog />
      </Suspense>

      <div>
        <h1 className="text-2xl font-semibold">{m['admin.dashboard_title']()}</h1>
      </div>

      <SetupChecklist />

      <CryptoStatusCard />

      <div className="space-y-8">
        {ADMIN_NAV_GROUPS.filter((group) => group.items.length > 0).map((group) => (
          <section key={group.heading()} className="space-y-3">
            <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">{group.heading()}</h2>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {group.items.map((item) => {
                const Icon = item.icon;
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
                          <CardTitle className="text-base">{item.label()}</CardTitle>
                        </div>
                        {item.description && <CardDescription>{item.description()}</CardDescription>}
                      </CardHeader>
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
