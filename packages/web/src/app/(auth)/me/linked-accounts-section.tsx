'use client';

import { useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { Link2, Link2Off } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { buildProviderLinkStartUrl } from '@/lib/auth-handoff';
import { useAuthProviders, useLinkedAuthProviders, useUnlinkAuthProvider } from '@/lib/use-auth-providers';
import { m } from '@paraglide/messages.js';

/** The `?link=` values the api's post-link redirect can land on `/me` with. */
const LINK_RESULT_MESSAGES = {
  linked: () => m['me.linked_accounts.result_linked'](),
  federated_identity_in_use: () => m['me.linked_accounts.result_in_use'](),
  link_failed: () => m['me.linked_accounts.result_failed'](),
} as const;

/**
 * RFC-0014 phase 4 — the Security-tab view of federated identities.
 *
 * Renders nothing at all when the instance has no federated providers
 * configured, so an instance that only uses passwords never sees an
 * empty "linked accounts" card.
 */
export function LinkedAccountsSection() {
  const searchParams = useSearchParams();
  // A completed link comes back as a full-page redirect to
  // `/me?provider=…&link=…` rather than an in-page mutation, so the
  // outcome is only readable from the URL.
  const linkResult = searchParams.get('link');
  const linkResultMessage = linkResult && linkResult in LINK_RESULT_MESSAGES ? LINK_RESULT_MESSAGES[linkResult as keyof typeof LINK_RESULT_MESSAGES]() : null;

  const { data: providers } = useAuthProviders();
  const { data: linked, isError: linkedFailed } = useLinkedAuthProviders();
  const unlink = useUnlinkAuthProvider();

  const [pendingUnlink, setPendingUnlink] = useState<{ name: string; label: string } | null>(null);
  const [linkError, setLinkError] = useState<string | null>(null);

  if (!providers || providers.length === 0) return null;

  // The server is the authority on whether an unlink is allowed, so a
  // failed one is surfaced verbatim rather than translated per code —
  // it already carries a specific reason (no password set, password
  // sign-in disabled instance-wide).
  const unlinkError = unlink.isError ? (unlink.error.message ?? m['me.linked_accounts.unlink_failed']()) : null;

  const startLink = async (provider: string) => {
    setLinkError(null);
    try {
      // `link=1` turns the same `/start` route into link mode; the api
      // requires a fresh single-use grant for it, minted below.
      window.location.assign(await buildProviderLinkStartUrl(provider, '/me'));
    } catch {
      setLinkError(m['me.linked_accounts.link_failed']());
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>{m['me.linked_accounts.title']()}</CardTitle>
        <CardDescription>{m['me.linked_accounts.description']()}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {linkResultMessage && (
          <Alert variant={linkResult === 'linked' ? 'default' : 'destructive'}>
            <AlertDescription>{linkResultMessage}</AlertDescription>
          </Alert>
        )}
        {linkedFailed && (
          <Alert variant="destructive">
            <AlertDescription>{m['me.linked_accounts.load_failed']()}</AlertDescription>
          </Alert>
        )}
        {linkError && (
          <Alert variant="destructive">
            <AlertDescription>{linkError}</AlertDescription>
          </Alert>
        )}
        {unlinkError && (
          <Alert variant="destructive">
            <AlertDescription>{unlinkError}</AlertDescription>
          </Alert>
        )}

        <ul className="divide-y rounded-md border">
          {providers.map((provider) => {
            const isLinked = linked?.includes(provider.name) ?? false;
            return (
              <li key={provider.name} className="flex items-center justify-between gap-4 p-3">
                <div className="min-w-0">
                  <div className="truncate font-medium">{provider.buttonLabel}</div>
                  <div className="text-sm text-muted-foreground">{isLinked ? m['me.linked_accounts.linked']() : m['me.linked_accounts.not_linked']()}</div>
                </div>
                {isLinked ? (
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    disabled={unlink.isPending}
                    onClick={() => setPendingUnlink({ name: provider.name, label: provider.buttonLabel })}
                  >
                    <Link2Off className="h-4 w-4" />
                    {m['me.linked_accounts.unlink']()}
                  </Button>
                ) : (
                  <Button type="button" variant="outline" size="sm" onClick={() => startLink(provider.name)}>
                    <Link2 className="h-4 w-4" />
                    {m['me.linked_accounts.link']()}
                  </Button>
                )}
              </li>
            );
          })}
        </ul>
      </CardContent>

      <AlertDialog open={pendingUnlink !== null} onOpenChange={(open) => !open && setPendingUnlink(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{m['me.linked_accounts.unlink_confirm_title']({ provider: pendingUnlink?.label ?? '' })}</AlertDialogTitle>
            <AlertDialogDescription>{m['me.linked_accounts.unlink_confirm_body']({ provider: pendingUnlink?.label ?? '' })}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{m['me.linked_accounts.unlink_confirm_cancel']()}</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                if (pendingUnlink) unlink.mutate(pendingUnlink.name);
                setPendingUnlink(null);
              }}
            >
              {m['me.linked_accounts.unlink_confirm_ok']()}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Card>
  );
}
