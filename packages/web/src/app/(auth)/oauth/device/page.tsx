'use client';

import { Suspense, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { CheckCircle2, XCircle } from 'lucide-react';
import { m } from '@paraglide/messages.js';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { apiClient } from '@/lib/api-client';
import { clientDisplayName } from '@/lib/oauth-clients';
import { ConsentCard } from '../authorize/consent-card';
import { DeviceForm } from './device-form';

type Step = { kind: 'enter' } | { kind: 'consent'; userCode: string; clientId: string; scopes: string[] } | { kind: 'done'; result: 'approved' | 'denied' };

/**
 * RFC-0010 Phase 4 — OAuth Device Authorization Grant consent screen
 * (RFC 8628). The user reaches this either by typing the `user_code` shown
 * by a headless CLI or by following `verification_uri_complete`
 * (`?user_code=`). Flow:
 *
 *   1. Enter / confirm the user_code → look it up via `GET /oauth/device`
 *      (returns the requesting client + requested scopes).
 *   2. Show the same consent card as the authorize-code flow (PHASE4-Q8) —
 *      all-or-nothing approval (PHASE4-Q3).
 *   3. Approve / deny → `POST /oauth/device/verify` → completion screen
 *      telling the user to return to the CLI.
 *
 * Lives under `(auth)`, so an unauthenticated user is redirected to login
 * first and returns here via `continue`.
 */
function DeviceScreen() {
  const params = useSearchParams();
  const initialUserCode = params.get('user_code') ?? '';

  const [step, setStep] = useState<Step>({ kind: 'enter' });
  const [isBusy, setIsBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const lookup = async (userCode: string) => {
    const trimmed = userCode.trim();
    if (trimmed.length === 0) return;
    setIsBusy(true);
    setError(null);
    try {
      const response = await apiClient.oauth.device.$get({ query: { user_code: trimmed } });
      if (response.status === 200) {
        const body = await response.json();
        setStep({ kind: 'consent', userCode: trimmed, clientId: body.client_id, scopes: body.scopes });
        return;
      }
      setError(m['oauth.device.error_not_found']());
    } catch {
      setError(m['oauth.device.error_failed']());
    } finally {
      setIsBusy(false);
    }
  };

  const verify = async (userCode: string, action: 'approve' | 'deny') => {
    setIsBusy(true);
    setError(null);
    try {
      const response = await apiClient.oauth.device.verify.$post({ json: { user_code: userCode, action } });
      if (response.status === 200) {
        const body = await response.json();
        setStep({ kind: 'done', result: body.status });
        return;
      }
      setError(m['oauth.device.error_failed']());
    } catch {
      setError(m['oauth.device.error_failed']());
    } finally {
      setIsBusy(false);
    }
  };

  if (step.kind === 'done') {
    const approved = step.result === 'approved';
    return (
      <Card className="w-full max-w-md">
        <CardHeader>
          <div className="flex items-center gap-2">
            {approved ? <CheckCircle2 className="size-5 text-[var(--crowi-primary)]" /> : <XCircle className="size-5 text-muted-foreground" />}
            <CardTitle>{approved ? m['oauth.device.done_approved_title']() : m['oauth.device.done_denied_title']()}</CardTitle>
          </div>
          <CardDescription>{approved ? m['oauth.device.done_approved_lead']() : m['oauth.device.done_denied_lead']()}</CardDescription>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-muted-foreground">{m['oauth.device.return_to_cli']()}</p>
        </CardContent>
      </Card>
    );
  }

  if (step.kind === 'consent') {
    return (
      <ConsentCard
        clientName={clientDisplayName(step.clientId)}
        scopes={step.scopes}
        error={error}
        isApproving={isBusy}
        onApprove={() => verify(step.userCode, 'approve')}
        onDeny={() => verify(step.userCode, 'deny')}
      />
    );
  }

  return <DeviceForm initialUserCode={initialUserCode} error={error} isSubmitting={isBusy} onSubmit={lookup} />;
}

export default function OAuthDevicePage() {
  return (
    <div className="flex justify-center py-8">
      <Suspense fallback={<div className="py-8 text-center text-muted-foreground">…</div>}>
        <DeviceScreen />
      </Suspense>
    </div>
  );
}
