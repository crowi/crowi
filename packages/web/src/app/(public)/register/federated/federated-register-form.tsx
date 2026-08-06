'use client';

import { UsernameSchema } from '@crowi/api-contract';
import { m } from '@paraglide/messages.js';
import { AtSign, LogIn, Mail, MailCheck, ShieldAlert } from 'lucide-react';
import { useRouter, useSearchParams } from 'next/navigation';
import { useEffect, useState } from 'react';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { FormErrorList } from '@/components/ui/form-error-list';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { apiClient } from '@/lib/api-client';
import { errorMessage } from '@/lib/error-message';
import { cancelFederatedRegistration } from '@/lib/federated-registration-cancel';

interface Snapshot {
  email: string;
  provider: string;
  providerLabel: string;
}

/**
 * RFC-0014 phase 2 — the registration screen a browser lands on after a
 * successful IdP round trip whose identity is unknown to Crowi (`?token=`
 * is the one-time `PendingAuthRegistration` grant Phase 1's callback
 * minted). Prefills email/provider read-only, lets the visitor choose a
 * username, and — per AC-2 — ALWAYS offers a logout exit: this is a
 * mid-registration state, not a signed-in session, so leaving must be one
 * click away regardless of which sub-view is showing.
 */
export function FederatedRegisterForm() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const token = searchParams.get('token');

  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [tokenInvalid, setTokenInvalid] = useState(false);
  const [loadError, setLoadError] = useState(false);
  const [isLoading, setIsLoading] = useState(true);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [approvalRequired, setApprovalRequired] = useState(false);
  const [errors, setErrors] = useState<string[]>([]);
  const [username, setUsername] = useState('');

  // Load the read-only snapshot. It carries `approvalPending` for the one
  // case the SUBMIT response cannot cover — arriving at (or returning to) a
  // grant whose registration was already submitted — while every invalid
  // grant shape stays a single indistinguishable 404.
  // A 404 (unknown/expired/cancelled/already-fully-completed grant — the
  // API deliberately never distinguishes which — AC-2) and a missing
  // `token` both land on the same "grant is no longer valid" card. Any
  // OTHER non-200 response, or a network-level failure, is a DIFFERENT,
  // distinguishable state (AC-8: expiry and a general error must not look
  // the same to the visitor) — a transient server error is retryable by
  // reloading the page, unlike an actually-invalid grant.
  useEffect(() => {
    if (!token) {
      setTokenInvalid(true);
      setIsLoading(false);
      return;
    }
    let active = true;
    (async () => {
      const res = await apiClient.auth['federated-registration'][':token'].$get({ param: { token } });
      if (!active) return;
      if (res.status === 200) {
        const body = await res.json();
        setSnapshot(body);
        // Already submitted and waiting for an admin — reached by pressing
        // Back from the pending screen. Show that state rather than an
        // editable username field: the registration is finalized, so a
        // second submit is refused and anything typed here is discarded.
        if (body.approvalPending) setApprovalRequired(true);
      } else if (res.status === 404) {
        setTokenInvalid(true);
      } else {
        setLoadError(true);
      }
      setIsLoading(false);
    })().catch(() => {
      if (active) {
        setLoadError(true);
        setIsLoading(false);
      }
    });
    return () => {
      active = false;
    };
  }, [token]);

  // Cancels the pending grant and always clears local tokens before
  // returning to /login, so an interrupted mid-registration visitor can
  // never be left in a half-authenticated limbo (AC-2).
  const handleLogout = async () => {
    await cancelFederatedRegistration(token);
    router.replace('/login');
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!token) return;

    // Client-side pre-check with the SAME schema the API enforces
    // (`UsernameSchema.safeParse`) — no independent regex/length rule.
    const parsedUsername = UsernameSchema.safeParse(username);
    if (!parsedUsername.success) {
      setErrors([m['auth.federated_register.invalid_username']()]);
      return;
    }

    setIsSubmitting(true);
    setErrors([]);

    try {
      // AC-4/AC-8: the request carries `username` ONLY — never a sender
      // key. The server binds the Open-mode success handoff to the
      // ORIGINAL `/auth/providers/{name}/start` sender key this journal
      // row was minted against (never a key THIS request could supply),
      // so a stolen registration URL alone cannot rebind the resulting
      // handoff to an attacker's own key.
      const response = await apiClient.auth['federated-registration'][':token'].$post({
        param: { token },
        json: { username: parsedUsername.data },
      });

      if (response.status === 200) {
        const body = await response.json();
        if (body.status === 'approval_required') {
          setApprovalRequired(true);
          return;
        }
        // Open success reuses Phase 1's OWN handoff contract as-is
        // (`/login/complete?code=...`, the SAME redirect
        // `hono/handlers/federated-auth.ts`'s callback issues for an
        // ordinary sign-in) rather than redeeming inline here — redemption
        // requires proof of the ORIGINAL `/start` sender key, which this
        // page never held to begin with (see the comment above).
        router.push(`/login/complete?code=${encodeURIComponent(body.code)}`);
        return;
      }
      if (response.status === 404) {
        setTokenInvalid(true);
        return;
      }
      const body = await response.json();
      const error = 'error' in body ? body.error : undefined;
      setErrors([errorMessage(error?.code, error?.message || m['auth.federated_register.error']())]);
    } catch {
      setErrors([m['auth.common.server_error']()]);
    } finally {
      setIsSubmitting(false);
    }
  };

  const logoutLink = (
    <button type="button" onClick={() => void handleLogout()} className="inline-flex items-center gap-1 text-sm text-primary hover:underline">
      <LogIn className="h-4 w-4" />
      {m['auth.federated_register.logout']()}
    </button>
  );

  if (isLoading) {
    return (
      <Card className="shadow-2xl">
        <CardContent className="p-6 space-y-4">
          <div className="animate-pulse space-y-4">
            <div className="h-6 bg-muted rounded w-1/3 mx-auto" />
            <div className="h-10 bg-muted rounded" />
            <div className="h-10 bg-muted rounded" />
            <div className="h-12 bg-muted rounded" />
          </div>
          <div className="pt-2 text-center">{logoutLink}</div>
        </CardContent>
      </Card>
    );
  }

  if (tokenInvalid) {
    return (
      <Card className="shadow-2xl">
        <CardHeader>
          <CardTitle className="text-xl text-center">{m['auth.federated_register.expired_title']()}</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <Alert variant="destructive">
            <ShieldAlert className="h-4 w-4" />
            <AlertDescription>{m['auth.federated_register.expired_body']()}</AlertDescription>
          </Alert>
          <div className="text-center">{logoutLink}</div>
        </CardContent>
      </Card>
    );
  }

  // AC-8: distinct from `tokenInvalid` — a 5xx or a network failure loading
  // the snapshot is a transient server problem (retryable by reloading),
  // not "this grant is no longer valid". Conflating the two would tell a
  // visitor hitting a temporary outage to restart the whole IdP sign-in
  // flow when simply reloading would have worked.
  if (loadError) {
    return (
      <Card className="shadow-2xl">
        <CardHeader>
          <CardTitle className="text-xl text-center">{m['auth.federated_register.load_error_title']()}</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <Alert variant="destructive">
            <ShieldAlert className="h-4 w-4" />
            <AlertDescription>{m['auth.federated_register.load_error_body']()}</AlertDescription>
          </Alert>
          <div className="text-center">{logoutLink}</div>
        </CardContent>
      </Card>
    );
  }

  if (approvalRequired) {
    return (
      <Card className="shadow-2xl">
        <CardHeader className="space-y-1">
          <CardTitle className="text-xl text-center">{m['auth.register.pending_approval_title']()}</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <Alert>
            <MailCheck className="h-4 w-4" />
            <AlertDescription>{m['auth.register.pending_approval_body']()}</AlertDescription>
          </Alert>
          {/* Same logout action as every other view (AC-2): the API DOES cancel
              an APPROVAL_PENDING row (it only leaves an already-ACTIVE User
              alone), so clicking here also invalidates this token — and this
              visitor still isn't signed in, so clearing local tokens before
              leaving matters exactly as much as anywhere else on this screen. */}
          <div className="text-center">{logoutLink}</div>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card className="shadow-2xl">
      <CardHeader className="space-y-1">
        <CardTitle className="text-xl text-center">{m['auth.federated_register.title']()}</CardTitle>
        <CardDescription className="text-center">{m['auth.federated_register.lead']({ provider: snapshot?.providerLabel ?? '' })}</CardDescription>
      </CardHeader>
      <CardContent>
        <FormErrorList errors={errors} />

        <form onSubmit={(e) => void handleSubmit(e)} className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="email">{m['auth.register.email_label']()}</Label>
            <div className="relative">
              <Mail className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
              <Input id="email" name="email" type="email" value={snapshot?.email ?? ''} className="pl-10" readOnly disabled />
            </div>
          </div>

          <div className="space-y-2">
            <Label htmlFor="username">{m['auth.register.userid_label']()}</Label>
            <div className="relative">
              <AtSign className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
              <Input
                id="username"
                name="username"
                type="text"
                placeholder={m['auth.register.userid_placeholder']()}
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                className="pl-10"
                required
                autoComplete="username"
              />
            </div>
            <p className="text-xs text-muted-foreground">{m['auth.register.userid_help']()}</p>
          </div>

          <Button type="submit" className="w-full" size="lg" disabled={isSubmitting}>
            {isSubmitting ? m['auth.register.submitting']() : m['auth.register.submit']()}
          </Button>
        </form>

        <div className="mt-6 pt-6 border-t text-center">{logoutLink}</div>
      </CardContent>
    </Card>
  );
}
