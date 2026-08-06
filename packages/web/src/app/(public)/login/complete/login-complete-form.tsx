'use client';

import { useEffect, useRef, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import Link from 'next/link';
import { ArrowLeft, Loader2 } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { completeAuthHandoff } from '@/lib/auth-handoff';
import { defaultLandingPath, safeContinueUrl } from '@/lib/login-redirect';
import { m } from '@paraglide/messages.js';

/**
 * RFC-0014 phase 4 — the landing page the api redirects to after a
 * federated sign-in succeeds.
 *
 * The whole job is redeeming the `code` in the URL for session tokens.
 * That redemption is single-use server-side and consumes this browser's
 * stored sender key, so it must happen exactly once per mount and must
 * never be retried: a second attempt cannot succeed, and re-running it
 * would only turn a transient failure into a confusing one.
 */
export function LoginCompleteForm() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const code = searchParams.get('code');
  const rawContinue = searchParams.get('continue');

  const [error, setError] = useState<string | null>(code ? null : m['auth.handoff.invalid']());
  const started = useRef(false);

  useEffect(() => {
    if (started.current || !code) return;
    started.current = true;

    (async () => {
      const result = await completeAuthHandoff(code);
      if (!result.ok) {
        setError(result.message);
        return;
      }
      // `/` is what `/start` sends when the user had no explicit
      // destination (the schema requires a continue, so "nothing" is
      // encoded as the root), which is exactly the case where password
      // sign-in lands people on their own user page. Treat it the same
      // way rather than dropping everyone on the portal root.
      const sanitized = safeContinueUrl(rawContinue);
      const destination = sanitized === '/' ? defaultLandingPath(result.username) : sanitized;
      // `replace`, not `push`: the code in this URL is spent, so leaving
      // it in history only gives the user a Back button that fails.
      router.replace(destination);
    })().catch(() => setError(m['auth.handoff.invalid']()));
  }, [code, rawContinue, router]);

  if (error) {
    return (
      <Card className="shadow-2xl">
        <CardHeader>
          <CardTitle className="text-xl text-center">{m['auth.handoff.title']()}</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <Alert variant="destructive">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
          <Link href="/login" className="inline-flex items-center gap-1 text-sm text-primary hover:underline">
            <ArrowLeft className="h-4 w-4" />
            {m['auth.handoff.back_to_login']()}
          </Link>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card className="shadow-2xl">
      <CardHeader>
        <CardTitle className="text-xl text-center">{m['auth.handoff.title']()}</CardTitle>
      </CardHeader>
      <CardContent className="flex items-center justify-center gap-2 text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin" />
        {m['auth.handoff.loading']()}
      </CardContent>
    </Card>
  );
}
