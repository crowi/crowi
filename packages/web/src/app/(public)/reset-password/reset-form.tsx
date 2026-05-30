'use client';

import { useEffect, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import Link from 'next/link';
import { ArrowLeft, KeyRound } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { apiClientV2 } from '@/lib/api-client';
import { storeTokens } from '@/lib/auth-token';
import { m } from '@paraglide/messages.js';

export function ResetPasswordForm() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const token = searchParams.get('token');

  const [tokenInvalid, setTokenInvalid] = useState(false);
  const [password, setPassword] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [errors, setErrors] = useState<string[]>([]);

  // Preflight: detect a dead/expired link before the user types.
  useEffect(() => {
    if (!token) {
      setTokenInvalid(true);
      return;
    }
    let active = true;
    (async () => {
      const res = await apiClientV2.auth['reset-password'].$get({ query: { token } });
      if (active && res.status !== 200) setTokenInvalid(true);
    })().catch(() => {
      if (active) setTokenInvalid(true);
    });
    return () => {
      active = false;
    };
  }, [token]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!token) return;
    setIsSubmitting(true);
    setErrors([]);
    try {
      const res = await apiClientV2.auth['reset-password'].$post({ json: { token, password } });
      if (res.status === 200) {
        const body = await res.json();
        storeTokens(body, body.expiresIn);
        router.push('/');
      } else {
        const body = await res.json();
        setErrors([('error' in body && body.error?.message) || m['auth.reset.error']()]);
      }
    } catch {
      setErrors([m['auth.common.server_error']()]);
    } finally {
      setIsSubmitting(false);
    }
  };

  if (tokenInvalid) {
    return (
      <Card className="shadow-2xl">
        <CardHeader>
          <CardTitle className="text-xl text-center">{m['auth.reset.invalid_title']()}</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <Alert variant="destructive">
            <AlertDescription>{m['auth.reset.invalid_body']()}</AlertDescription>
          </Alert>
          <Link href="/forgot-password" className="inline-flex items-center gap-1 text-sm text-primary hover:underline">
            <ArrowLeft className="h-4 w-4" />
            {m['auth.reset.resend_link']()}
          </Link>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card className="shadow-2xl">
      <CardHeader className="space-y-1">
        <CardTitle className="text-xl text-center">{m['auth.reset.heading']()}</CardTitle>
      </CardHeader>
      <CardContent>
        {errors.length > 0 && (
          <Alert variant="destructive" className="mb-4">
            <AlertDescription>
              <ul className="list-disc list-inside space-y-1">
                {errors.map((error, index) => (
                  <li key={index}>{error}</li>
                ))}
              </ul>
            </AlertDescription>
          </Alert>
        )}
        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="password">{m['auth.reset.password_label']()}</Label>
            <div className="relative">
              <KeyRound className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
              <Input
                id="password"
                name="password"
                type="password"
                placeholder="Password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                className="pl-10"
                required
                minLength={6}
                autoComplete="new-password"
              />
            </div>
          </div>
          <Button type="submit" className="w-full" size="lg" disabled={isSubmitting}>
            {isSubmitting ? m['auth.reset.submitting']() : m['auth.reset.submit']()}
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}
