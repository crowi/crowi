'use client';

import { m } from '@paraglide/messages.js';
import { Settings as SettingsIcon, Shield, User } from 'lucide-react';
import { useSearchParams } from 'next/navigation';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';

interface SettingsLayoutProps {
  profileTab: React.ReactNode;
  securityTab?: React.ReactNode;
}

const TAB_VALUES = ['profile', 'security'] as const;

/**
 * Which tab to open on arrival.
 *
 * `?tab=` (an explicit, valid value) always wins. Failing that:
 *   - `?provider=&link_completion=` (both present) is the successful
 *     callback redirect. `page.tsx`'s page-boundary effect captures this and
 *     rewrites the URL via `history.replaceState` (adding `tab=security`,
 *     stripping `link_completion`), but that raw History API call is not
 *     guaranteed to be reflected back through THIS component's own
 *     `useSearchParams()` read on every render — so `initialTab` still has
 *     to recognise the query shape directly, not rely solely on the
 *     rewritten `?tab=security` landing here first.
 *   - `?link=` alone (no `link_completion`) is a callback FAILURE redirect
 *     (`link=link_failed`) — same tab, no completion to show.
 */
function initialTab(params: URLSearchParams): (typeof TAB_VALUES)[number] {
  const requested = params.get('tab');
  if (requested && (TAB_VALUES as readonly string[]).includes(requested)) return requested as (typeof TAB_VALUES)[number];
  if (params.has('provider') && params.has('link_completion')) return 'security';
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
