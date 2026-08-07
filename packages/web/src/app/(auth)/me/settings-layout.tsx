'use client';

import { useSearchParams } from 'next/navigation';
import { User, Shield, Settings as SettingsIcon } from 'lucide-react';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { m } from '@paraglide/messages.js';

interface SettingsLayoutProps {
  profileTab: React.ReactNode;
  securityTab?: React.ReactNode;
}

const TAB_VALUES = ['profile', 'security'] as const;

/**
 * Which tab to open on arrival.
 *
 * `?tab=` makes the tabs linkable at all — without it every entry point
 * lands on Profile. `?link=` earns the same treatment because it is only
 * ever set by the api's post-link redirect, whose whole point is to show
 * an outcome that lives on the security tab: landing on Profile put the
 * "account linked" message on a tab the user was not looking at.
 */
function initialTab(params: URLSearchParams): (typeof TAB_VALUES)[number] {
  const requested = params.get('tab');
  if (requested && (TAB_VALUES as readonly string[]).includes(requested)) return requested as (typeof TAB_VALUES)[number];
  if (params.has('link')) return 'security';
  return 'profile';
}

export function SettingsLayout({ profileTab, securityTab }: SettingsLayoutProps) {
  const searchParams = useSearchParams();
  return (
    <>
      <div className="mb-8">
        <h1 className="text-3xl font-bold flex items-center gap-2">
          <SettingsIcon className="size-8" />
          {m['me.heading']()}
        </h1>
        <p className="text-muted-foreground mt-2">{m['me.subheading']()}</p>
      </div>

      {/* `defaultValue`, not `value`: the URL picks the tab you arrive on,
          then clicking takes over. Driving it from the URL would need a
          router push per click for no benefit. */}
      <Tabs defaultValue={initialTab(searchParams)} className="space-y-6">
        <TabsList className="w-full justify-start">
          <TabsTrigger value="profile" className="flex items-center gap-2">
            <User className="size-4" />
            {m['me.tab_profile']()}
          </TabsTrigger>
          <TabsTrigger value="security" className="flex items-center gap-2">
            <Shield className="size-4" />
            {m['me.tab_security']()}
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
