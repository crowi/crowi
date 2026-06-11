'use client';

import Link from 'next/link';
import { ChevronRight, HardDrive, Search, Mail, Users, Check } from 'lucide-react';
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { useAppSettings, useUpdateAppSettings } from '@/lib/use-admin-app-settings';
import { m } from '@paraglide/messages.js';

/**
 * Initial-setup checklist surfaced on the admin dashboard. Each item is a
 * deep link into the matching admin section with a short description, so a
 * freshly-installed instance has an obvious next-step path. Text-only by
 * design (no screenshots) to stay locale-agnostic and low-maintenance.
 *
 * The "mark as done" button persists the dismissal server-side via the
 * `app:setupChecklistDismissed` flag (carried on the existing /admin/app
 * GET/PUT), so once dismissed the checklist stays hidden across browsers
 * and devices rather than just one localStorage.
 */
const SETUP_ITEMS = [
  { href: '/admin/storage', icon: HardDrive, title: () => m['admin.setup.storage_title'](), body: () => m['admin.setup.storage_body']() },
  { href: '/admin/search', icon: Search, title: () => m['admin.setup.search_title'](), body: () => m['admin.setup.search_body']() },
  { href: '/admin/mail', icon: Mail, title: () => m['admin.setup.mail_title'](), body: () => m['admin.setup.mail_body']() },
  { href: '/admin/users', icon: Users, title: () => m['admin.setup.users_title'](), body: () => m['admin.setup.users_body']() },
] as const;

export function SetupChecklist() {
  const { data, isLoading } = useAppSettings();
  const dismiss = useUpdateAppSettings();

  // Hide while loading so a dismissed checklist never flashes in before the
  // flag arrives, and hide once the admin has dismissed it.
  if (isLoading || data?.setupChecklistDismissed === true) return null;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">{m['admin.setup.title']()}</CardTitle>
        <CardDescription>{m['admin.setup.subtitle']()}</CardDescription>
        <CardAction>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => dismiss.mutate({ setupChecklistDismissed: true })}
            disabled={dismiss.isPending}
            aria-label={m['admin.setup.dismiss']()}
          >
            <Check className="h-4 w-4" />
            {m['admin.setup.dismiss']()}
          </Button>
        </CardAction>
      </CardHeader>
      <CardContent>
        <ul className="divide-y divide-border">
          {SETUP_ITEMS.map((item) => {
            const Icon = item.icon;
            return (
              <li key={item.href}>
                <Link
                  href={item.href}
                  className="group flex items-center gap-3 py-3 transition-colors hover:text-primary focus:outline-none focus-visible:text-primary"
                >
                  <Icon className="h-5 w-5 shrink-0 text-primary" />
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-medium">{item.title()}</p>
                    <p className="text-muted-foreground text-sm">{item.body()}</p>
                  </div>
                  <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground transition-transform group-hover:translate-x-0.5" />
                </Link>
              </li>
            );
          })}
        </ul>
      </CardContent>
    </Card>
  );
}
