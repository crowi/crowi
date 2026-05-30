'use client';

import { useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import Link from 'next/link';
import { ArrowLeft, CheckCircle2, Loader2 } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { apiClientV2 } from '@/lib/api-client';

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
          <CardTitle className="text-xl text-center">リンクが無効です</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <Alert variant="destructive">
            <AlertDescription>この確認リンクは無効か、有効期限が切れています。設定画面からもう一度お試しください。</AlertDescription>
          </Alert>
          <Link href="/login" className="inline-flex items-center gap-1 text-sm text-primary hover:underline">
            <ArrowLeft className="h-4 w-4" />
            サインインに戻る
          </Link>
        </CardContent>
      </Card>
    );
  }

  if (phase === 'done') {
    return (
      <Card className="shadow-2xl">
        <CardHeader>
          <CardTitle className="text-xl text-center">メールアドレスを変更しました</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <Alert>
            <CheckCircle2 className="h-4 w-4" />
            <AlertDescription>メールアドレスを{email ? ` ${email} ` : ''}に変更しました。次回から新しいアドレスでサインインできます。</AlertDescription>
          </Alert>
          <Link href="/" className="inline-flex items-center gap-1 text-sm text-primary hover:underline">
            <ArrowLeft className="h-4 w-4" />
            ホームへ戻る
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
          <p>メールアドレスを確認しています...</p>
        </div>
      </CardContent>
    </Card>
  );
}
