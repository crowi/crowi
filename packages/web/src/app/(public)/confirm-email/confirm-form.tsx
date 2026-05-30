'use client';

import { useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import Link from 'next/link';
import { ArrowLeft, CheckCircle2, Loader2 } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { apiClientV2 } from '@/lib/api-client';
import { m } from '@paraglide/messages.js';

type Phase = 'confirming' | 'done' | 'error';

export function ConfirmEmailForm() {
  const searchParams = useSearchParams();
  const token = searchParams.get('token');

  // No-token error is derived at render to avoid a synchronous setState
  // inside the effect.
  const [phase, setPhase] = useState<Phase>(token ? 'confirming' : 'error');
  const [email, setEmail] = useState<string | null>(null);
  const started = useRef(false);

  useEffect(() => {
    if (started.current || !token) return;
    started.current = true;

    (async () => {
      const res = await apiClientV2.auth['confirm-email-change'].$post({ json: { token } });
      if (res.status === 200) {
        const body = await res.json();
        setEmail(body.email);
        setPhase('done');
      } else {
        setPhase('error');
      }
    })().catch(() => setPhase('error'));
  }, [token]);

  if (phase === 'error') {
    return (
      <Card className="shadow-2xl">
        <CardHeader>
          <CardTitle className="text-xl text-center">{m['auth.confirm_email.invalid_title']()}</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <Alert variant="destructive">
            <AlertDescription>{m['auth.confirm_email.invalid_body']()}</AlertDescription>
          </Alert>
          <Link href="/login" className="inline-flex items-center gap-1 text-sm text-primary hover:underline">
            <ArrowLeft className="h-4 w-4" />
            {m['auth.common.back_to_signin']()}
          </Link>
        </CardContent>
      </Card>
    );
  }

  if (phase === 'done') {
    return (
      <Card className="shadow-2xl">
        <CardHeader>
          <CardTitle className="text-xl text-center">{m['auth.confirm_email.done_title']()}</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <Alert>
            <CheckCircle2 className="h-4 w-4" />
            <AlertDescription>{email ? m['auth.confirm_email.done_body']({ email }) : m['auth.confirm_email.done_body_no_email']()}</AlertDescription>
          </Alert>
          <Link href="/" className="inline-flex items-center gap-1 text-sm text-primary hover:underline">
            <ArrowLeft className="h-4 w-4" />
            {m['auth.confirm_email.back_home']()}
          </Link>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card className="shadow-2xl">
      <CardContent className="py-10">
        <div className="flex flex-col items-center gap-3 text-muted-foreground">
          <Loader2 className="h-6 w-6 animate-spin" />
          <p>{m['auth.confirm_email.loading']()}</p>
        </div>
      </CardContent>
    </Card>
  );
}
