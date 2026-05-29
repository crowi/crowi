'use client';

import { useEffect, useRef, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import Link from 'next/link';
import { ArrowLeft, Loader2 } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { apiClientV2 } from '@/lib/api-client';
import { storeTokens } from '@/lib/auth-token';

type Phase = 'activating' | 'error';

export function ActivateForm() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const token = searchParams.get('token');

  // Derive the no-token error state at render (avoids a synchronous
  // setState inside the effect). With a token we start in 'activating'.
  const [phase, setPhase] = useState<Phase>(token ? 'activating' : 'error');
  // Activation has no form input: confirming the email is the whole action,
  // so we POST the token once on mount and sign the user in on success.
  const started = useRef(false);

  useEffect(() => {
    if (started.current || !token) return;
    started.current = true;

    (async () => {
      const res = await apiClientV2.auth.activate.$post({ json: { token } });
      if (res.status === 200) {
        const body = await res.json();
        storeTokens(body, body.expiresIn);
        router.push('/');
      } else {
        setPhase('error');
      }
    })().catch(() => setPhase('error'));
  }, [token, router]);

  if (phase === 'error') {
    return (
      <Card className="shadow-2xl">
        <CardHeader>
          <CardTitle className="text-xl text-center">リンクが無効です</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <Alert variant="destructive">
            <AlertDescription>この有効化リンクは無効か、有効期限が切れています。お手数ですが再度ご登録ください。</AlertDescription>
          </Alert>
          <Link href="/login" className="inline-flex items-center gap-1 text-sm text-primary hover:underline">
            <ArrowLeft className="h-4 w-4" />
            サインインに戻る
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
          <p>アカウントを有効化しています...</p>
        </div>
      </CardContent>
    </Card>
  );
}
