'use client';

import { m } from '@paraglide/messages.js';
import { getLocale } from '@paraglide/runtime.js';
import { useSearchParams } from 'next/navigation';
import { Suspense, useEffect, useRef, useState } from 'react';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { usePageTitle } from '@/lib/use-page-title';
import { useProfile } from '@/lib/use-profile';
import { AccessTokensSection } from './access-tokens-section';
import { LinkedAccountsSection, type PendingLinkCompletion, PendingLinkCompletionContainer } from './linked-accounts-section';
import { McpSetupSection } from './mcp-setup-section';
import { PasswordForm } from './password-form';
import { ProfileForm } from './profile-form';
import { ProfilePicture } from './profile-picture';
import { SettingsLayout } from './settings-layout';

function LoadingBody() {
  return (
    <div className="flex items-center justify-center h-64">
      <div className="text-center space-y-4">
        <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-primary mx-auto" />
        <p className="text-muted-foreground">{m['me.loading']()}</p>
      </div>
    </div>
  );
}

/**
 * The always-
 * mounted inner component. `useSearchParams`'s CSR-bailout requirement is
 * satisfied by wrapping ONLY this component in `<Suspense>` — see
 * `SettingsPage` below — the file-level default export itself stays a
 * plain boundary with no hooks of its own.
 *
 * The completion-code capture effect runs BEFORE (i.e. independent of)
 * `useProfile`'s own loading/error/not-found branches below: a link
 * callback can land here while the profile fetch is still in flight, and
 * the code must not be lost to a race with that unrelated request.
 * `PendingLinkCompletionContainer` is likewise rendered unconditionally,
 * outside every profile-state branch, so the confirmation dialog can open
 * regardless of what the Profile/Security tabs are doing.
 */
function SettingsPageContent() {
  const searchParams = useSearchParams();
  const [pending, setPending] = useState<PendingLinkCompletion | null>(null);
  // One-shot: a later re-render (e.g. profile finishing its own fetch)
  // must never re-capture/re-strip the URL a second time.
  const captured = useRef(false);

  useEffect(() => {
    if (captured.current) return;
    const provider = searchParams.get('provider');
    const code = searchParams.get('link_completion');
    // Both or neither — a bare `?provider=` with no code (or vice versa)
    // is not a completion redirect and is left alone.
    if (!provider || !code) return;
    captured.current = true;
    // Capturing a one-time arrival value off the URL, paired with an
    // unavoidable imperative `history.replaceState` right below — this is
    // exactly the "synchronize with an external system" case `useEffect`
    // exists for, not state derivable during render (the ref guard makes
    // it run at most once per mount).
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setPending({ provider, code });

    const url = new URL(window.location.href);
    url.searchParams.delete('link_completion');
    url.searchParams.set('tab', 'security');
    window.history.replaceState(window.history.state, '', `${url.pathname}${url.search}${url.hash}`);
  }, [searchParams]);

  const { data: profile, isLoading, error } = useProfile();
  usePageTitle(m['me.heading']());

  const dateLocale = getLocale() === 'ja' ? 'ja-JP' : 'en-US';

  let body: React.ReactNode;
  if (isLoading) {
    body = <LoadingBody />;
  } else if (error) {
    body = (
      <Alert variant="destructive">
        <AlertDescription>{m['me.failed_to_load']()}</AlertDescription>
      </Alert>
    );
  } else if (!profile) {
    body = (
      <Alert variant="destructive">
        <AlertDescription>{m['me.profile_not_found']()}</AlertDescription>
      </Alert>
    );
  } else {
    body = <ProfileSettingsLayout profile={profile} dateLocale={dateLocale} />;
  }

  return (
    <>
      {body}
      <PendingLinkCompletionContainer pending={pending} onPendingChange={setPending} />
    </>
  );
}

export default function SettingsPage() {
  return (
    <Suspense fallback={<LoadingBody />}>
      <SettingsPageContent />
    </Suspense>
  );
}

function ProfileSettingsLayout({ profile, dateLocale }: { profile: NonNullable<ReturnType<typeof useProfile>['data']>; dateLocale: string }) {
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
