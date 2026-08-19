'use client';

import { m } from '@paraglide/messages.js';
import { Link2, Link2Off } from 'lucide-react';
import { useState } from 'react';
import { Alert, AlertDescription } from '@/components/ui/alert';
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
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import {
  type ProviderLinkError,
  useAuthProviders,
  useCompleteProviderLink,
  useLinkedAuthProviders,
  usePendingLinkCompletion,
  useStartProviderLink,
  useUnlinkAuthProvider,
} from '@/lib/use-auth-providers';

/** A completion code captured off the callback redirect (`/me?provider=<p>&link_completion=<code>`), owned by the page boundary — see `page.tsx`. */
export interface PendingLinkCompletion {
  provider: string;
  code: string;
}

export interface PendingLinkCompletionContainerProps {
  pending: PendingLinkCompletion | null;
  onPendingChange(value: PendingLinkCompletion | null): void;
}

/**
 * The final POST's terminal outcomes (design decision 18) — a stable,
 * closed set. `malformed`/`generic_failed` share the same generic wording;
 * every other kind gets its own message.
 */
type TerminalResultKind = 'linked' | 'malformed' | 'invalid_or_expired' | 'identity_in_use' | 'auth_state_changed' | 'not_linked' | 'generic_failed';

function terminalResultKindFor(code: string | undefined): TerminalResultKind {
  switch (code) {
    case 'VALIDATION_ERROR':
      return 'malformed';
    case 'NOT_FOUND':
      return 'invalid_or_expired';
    case 'FEDERATED_IDENTITY_IN_USE':
      return 'identity_in_use';
    case 'FEDERATED_LINK_AUTH_STATE_CHANGED':
      return 'auth_state_changed';
    case 'FEDERATED_LINK_NOT_LINKED':
      return 'not_linked';
    default:
      return 'generic_failed';
  }
}

const TERMINAL_RESULT_MESSAGES: Record<TerminalResultKind, () => string> = {
  linked: () => m['me.linked_accounts.result_linked'](),
  malformed: () => m['me.linked_accounts.result_failed'](),
  invalid_or_expired: () => m['me.linked_accounts.confirm.result_invalid_or_expired'](),
  identity_in_use: () => m['me.linked_accounts.result_in_use'](),
  auth_state_changed: () => m['me.linked_accounts.confirm.result_auth_state_changed'](),
  not_linked: () => m['me.linked_accounts.confirm.result_not_linked'](),
  generic_failed: () => m['me.linked_accounts.result_failed'](),
};

/** A 2xx or a retryable (network/5xx) outcome never reaches here — those are handled inline. */
function isRetryableError(error: ProviderLinkError): boolean {
  return error.status === 0 || error.status >= 500;
}

/**
 * The confirmation dialog for a
 * pending link completion, mounted from the page boundary
 * (`page.tsx#SettingsPageContent`) independent of profile/provider-list
 * loading state or which Security-tab card happens to be visible. Opens
 * purely from `pending` being non-null; its internal view state (loading /
 * confirm / error+retry / terminal result) is entirely local.
 */
export function PendingLinkCompletionContainer({ pending, onPendingChange }: PendingLinkCompletionContainerProps) {
  const { data: providers } = useAuthProviders();
  const confirmation = usePendingLinkCompletion(pending?.provider ?? null, pending?.code ?? null);
  const complete = useCompleteProviderLink();

  const [terminalResultKind, setTerminalResultKind] = useState<TerminalResultKind | null>(null);
  const [confirmRetryMessage, setConfirmRetryMessage] = useState<string | null>(null);

  const dialogOpen = pending !== null || terminalResultKind !== null;
  if (!dialogOpen) return null;

  // Provider list is a label lookup ONLY — loading/error/empty/not-found all fall back to the raw slug (never blocks or closes the dialog).
  const providerLabel = pending ? (providers?.find((p) => p.name === pending.provider)?.buttonLabel ?? pending.provider) : '';

  const handleCancel = () => {
    onPendingChange(null);
  };

  const handleClose = () => {
    setTerminalResultKind(null);
  };

  const handleConfirm = () => {
    if (!pending) return;
    setConfirmRetryMessage(null);
    complete.mutate(
      { provider: pending.provider, code: pending.code },
      {
        onSuccess: () => {
          setTerminalResultKind('linked');
          onPendingChange(null);
        },
        onError: (error) => {
          if (isRetryableError(error)) {
            // network/timeout/500 — keep the SAME code so this action can be resent (design decision 20).
            setConfirmRetryMessage(error.message);
            return;
          }
          // 2xx and 4xx alike discard the code — a retry can never resolve differently.
          setTerminalResultKind(terminalResultKindFor(error.code));
          onPendingChange(null);
        },
      },
    );
  };

  const handleDialogOpenChange = (next: boolean) => {
    if (next) return;
    if (terminalResultKind) handleClose();
    else handleCancel();
  };

  return (
    <AlertDialog open={dialogOpen} onOpenChange={handleDialogOpenChange}>
      <AlertDialogContent>
        {terminalResultKind ? (
          <>
            <AlertDialogHeader>
              <AlertDialogTitle>{m['me.linked_accounts.title']()}</AlertDialogTitle>
              <AlertDialogDescription>{TERMINAL_RESULT_MESSAGES[terminalResultKind]()}</AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogAction onClick={handleClose}>{m['me.linked_accounts.confirm.close_action']()}</AlertDialogAction>
            </AlertDialogFooter>
          </>
        ) : confirmation.isLoading ? (
          <AlertDialogHeader>
            <AlertDialogTitle>{m['me.linked_accounts.confirm.loading']()}</AlertDialogTitle>
          </AlertDialogHeader>
        ) : confirmation.isError ? (
          <>
            <AlertDialogHeader>
              <AlertDialogTitle>{m['me.linked_accounts.confirm.load_error']()}</AlertDialogTitle>
              <AlertDialogDescription>{confirmation.error.message}</AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel onClick={handleCancel}>{m['me.linked_accounts.confirm.cancel_action']()}</AlertDialogCancel>
              {/* A plain `Button`, NOT `AlertDialogAction` — Radix's Action
                  primitive dismisses the dialog on click unconditionally,
                  which would discard `pending` via `onOpenChange` before
                  the retry ever resolves. This button must NOT close the
                  dialog; only `handleConfirm`'s own outcome decides that. */}
              <Button type="button" onClick={() => confirmation.refetch()}>
                {m['me.linked_accounts.confirm.retry_action']()}
              </Button>
            </AlertDialogFooter>
          </>
        ) : confirmation.data ? (
          <>
            <AlertDialogHeader>
              <AlertDialogTitle>
                {confirmation.data.accountLabel
                  ? m['me.linked_accounts.confirm.title_with_account']({ provider: providerLabel, account: confirmation.data.accountLabel })
                  : m['me.linked_accounts.confirm.title']({ provider: providerLabel })}
              </AlertDialogTitle>
              {confirmRetryMessage && <AlertDialogDescription className="text-destructive">{confirmRetryMessage}</AlertDialogDescription>}
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel onClick={handleCancel}>{m['me.linked_accounts.confirm.cancel_action']()}</AlertDialogCancel>
              {/* Plain `Button` — see the retry button's comment above. A
                  network/500 failure must leave the dialog open with this
                  SAME button still able to resend (design decision 20). */}
              <Button type="button" disabled={complete.isPending} onClick={handleConfirm}>
                {m['me.linked_accounts.confirm.link_action']()}
              </Button>
            </AlertDialogFooter>
          </>
        ) : null}
      </AlertDialogContent>
    </AlertDialog>
  );
}

/**
 * The Security-tab
 * view of federated identities. Owns the ordinary provider list / Link /
 * Unlink card; the confirmation dialog for a pending completion lives in
 * `PendingLinkCompletionContainer` above (mounted separately, at the page
 * boundary — see `page.tsx`), so this component's own loading/error/empty
 * states never gate it.
 *
 * Renders nothing at all when the instance has no federated providers
 * configured, so an instance that only uses passwords never sees an
 * empty "linked accounts" card.
 */
export function LinkedAccountsSection() {
  const { data: providers } = useAuthProviders();
  const { data: linked, isError: linkedFailed } = useLinkedAuthProviders();
  const unlink = useUnlinkAuthProvider();
  const startLink = useStartProviderLink();

  const [pendingUnlink, setPendingUnlink] = useState<{ name: string; label: string } | null>(null);

  if (!providers || providers.length === 0) return null;

  // The server is the authority on whether an unlink is allowed, so a
  // failed one is surfaced verbatim rather than translated per code —
  // it already carries a specific reason (no password set, password
  // sign-in disabled instance-wide).
  const unlinkError = unlink.isError ? (unlink.error.message ?? m['me.linked_accounts.unlink_failed']()) : null;
  const startError = startLink.isError ? m['me.linked_accounts.link_failed']() : null;

  const handleStartLink = (provider: string) => {
    startLink.mutate(provider, {
      onSuccess: (data) => {
        // A full top-level navigation, not a client-side route change — the
        // browser is leaving for the IdP. No Authorization header rides
        // this navigation; only the flow-specific cookie `link-start` just
        // set does (design decision 6).
        window.location.assign(data.authorizationUrl);
      },
    });
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>{m['me.linked_accounts.title']()}</CardTitle>
        <CardDescription>{m['me.linked_accounts.description']()}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {startError && (
          <Alert variant="destructive">
            <AlertDescription>{startError}</AlertDescription>
          </Alert>
        )}
        {linkedFailed && (
          <Alert variant="destructive">
            <AlertDescription>{m['me.linked_accounts.load_failed']()}</AlertDescription>
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
                  <Button type="button" variant="outline" size="sm" disabled={startLink.isPending} onClick={() => handleStartLink(provider.name)}>
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
