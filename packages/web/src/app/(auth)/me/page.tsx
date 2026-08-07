'use client';

import { useProfile } from '@/lib/use-profile';
import { usePageTitle } from '@/lib/use-page-title';
import { SettingsLayout } from './settings-layout';
import { ProfileForm } from './profile-form';
import { ProfilePicture } from './profile-picture';
import { PasswordForm } from './password-form';
import { McpSetupSection } from './mcp-setup-section';
import { AccessTokensSection } from './access-tokens-section';
import { LinkedAccountsSection } from './linked-accounts-section';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { m } from '@paraglide/messages.js';
import { getLocale } from '@paraglide/runtime.js';

export default function SettingsPage() {
  const { data: profile, isLoading, error } = useProfile();
  usePageTitle(m['me.heading']());

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="text-center space-y-4">
          <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-primary mx-auto" />
          <p className="text-muted-foreground">{m['me.loading']()}</p>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <Alert variant="destructive">
        <AlertDescription>{m['me.failed_to_load']()}</AlertDescription>
      </Alert>
    );
  }

  if (!profile) {
    return (
      <Alert variant="destructive">
        <AlertDescription>{m['me.profile_not_found']()}</AlertDescription>
      </Alert>
    );
  }

  const dateLocale = getLocale() === 'ja' ? 'ja-JP' : 'en-US';

  return (
    <SettingsLayout
      profileTab={
        <div className="space-y-6">
          <Card>
            <CardHeader>
              <CardTitle>{m['me.profile_picture.heading']()}</CardTitle>
              <CardDescription>{m['me.profile_picture.lead']()}</CardDescription>
            </CardHeader>
            <CardContent>
              <ProfilePicture profile={profile} />
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>{m['me.profile.heading']()}</CardTitle>
              <CardDescription>{m['me.profile.lead']()}</CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              {profile.federated && (
                <Alert>
                  <AlertDescription>
                    {m['me.profile.federated_notice']()}{' '}
                    {/* `window.location.assign`, not next/link: the Security
                        tab is chosen from the URL only on mount
                        (`SettingsLayout`'s `initialTab`), so getting there
                        from an already-mounted Profile tab needs a full
                        navigation — a client-side route transition would
                        leave the uncontrolled Tabs component on its current
                        value. A plain `<a href>` would navigate correctly but
                        trips `@next/next/no-html-link-for-pages`. Same
                        technique as `LinkedAccountsSection`'s `startLink`. */}
                    <Button type="button" variant="link" className="h-auto p-0" onClick={() => window.location.assign('/me?tab=security')}>
                      {m['me.profile.federated_notice_link']()}
                    </Button>
                  </AlertDescription>
                </Alert>
              )}
              <ProfileForm profile={profile} />
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>{m['me.account_info.heading']()}</CardTitle>
              <CardDescription>{m['me.account_info.lead']()}</CardDescription>
            </CardHeader>
            <CardContent className="space-y-2">
              <div className="grid grid-cols-2 gap-4 text-sm">
                <div>
                  <p className="text-muted-foreground">{m['me.account_info.account_id']()}</p>
                  <p className="font-mono">{profile.id}</p>
                </div>
                <div>
                  <p className="text-muted-foreground">{m['me.account_info.created_at']()}</p>
                  <p>{new Date(profile.createdAt).toLocaleString(dateLocale)}</p>
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
              <CardTitle>{m['me.password.heading']()}</CardTitle>
              <CardDescription>{m['me.password.lead']()}</CardDescription>
            </CardHeader>
            <CardContent>
              <PasswordForm profile={profile} />
            </CardContent>
          </Card>

          <LinkedAccountsSection />

          <Card>
            <CardHeader>
              <CardTitle>{m['me.mcp.heading']()}</CardTitle>
              <CardDescription>{m['me.mcp.lead']()}</CardDescription>
            </CardHeader>
            <CardContent>
              <McpSetupSection />
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>{m['me.access_tokens.heading']()}</CardTitle>
              <CardDescription>{m['me.access_tokens.lead']()}</CardDescription>
            </CardHeader>
            <CardContent>
              <AccessTokensSection />
            </CardContent>
          </Card>
        </div>
      }
    />
  );
}
