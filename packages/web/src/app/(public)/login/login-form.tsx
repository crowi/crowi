'use client';

import { useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import Link from 'next/link';
import { Mail, KeyRound, PenLine } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { apiClientV2 } from '@/lib/api-client';
import { storeTokens } from '@/lib/auth-token';
import { safeContinueUrl } from '@/lib/login-redirect';

export function LoginForm() {
  const router = useRouter();
  const searchParams = useSearchParams();
  // Anything not a same-origin relative path is dropped — prevents
  // open-redirect via a crafted `?continue=https://evil.example/` link.
  const continueUrl = safeContinueUrl(searchParams.get('continue'));

  const [isSubmitting, setIsSubmitting] = useState(false);
  const [errors, setErrors] = useState<string[]>([]);
  const [formData, setFormData] = useState({
    email: '',
    password: '',
  });

  const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const { name, value } = e.target;
    setFormData((prev) => ({ ...prev, [name]: value }));
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setIsSubmitting(true);
    setErrors([]);

    try {
      // RFC-0006 Phase 4 Batch 1 — switched from
      // `apiClient.tokenAuth.tokenLogin` to `apiClientV2.auth.login.$post`.
      // Wire format unchanged: 200 + `{ accessToken, refreshToken, … }` on
      // success; 401/403/500/503 with `{ error: { code, message } }` on
      // failure.
      const response = await apiClientV2.auth.login.$post({
        json: {
          email: formData.email,
          password: formData.password,
        },
      });

      if (response.status === 200) {
        const body = await response.json();
        // Store tokens (also mirrors access token into a cookie so
        // browser-built `<img>` requests can authenticate).
        storeTokens(body, body.expiresIn);

        // Redirect to continue URL
        router.push(continueUrl);
      } else if (response.status === 401 || response.status === 403 || response.status === 503) {
        const body = await response.json();
        setErrors([body.error?.message || 'ログインに失敗しました']);
      } else {
        setErrors(['予期しないエラーが発生しました']);
      }
    } catch {
      setErrors(['サーバーとの通信中にエラーが発生しました']);
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <Card className="shadow-2xl">
      <CardHeader className="space-y-1">
        <CardTitle className="text-xl text-center">サインイン</CardTitle>
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
            <Label htmlFor="email">メールアドレス</Label>
            <div className="relative">
              <Mail className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
              <Input
                id="email"
                name="email"
                type="email"
                placeholder="E-mail"
                value={formData.email}
                onChange={handleChange}
                className="pl-10"
                required
                autoComplete="email"
              />
            </div>
          </div>

          <div className="space-y-2">
            <Label htmlFor="password">パスワード</Label>
            <div className="relative">
              <KeyRound className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
              <Input
                id="password"
                name="password"
                type="password"
                placeholder="Password"
                value={formData.password}
                onChange={handleChange}
                className="pl-10"
                required
                autoComplete="current-password"
              />
            </div>
          </div>

          <Button type="submit" className="w-full" size="lg" disabled={isSubmitting}>
            {isSubmitting ? 'サインイン中...' : 'サインイン'}
          </Button>
        </form>

        <div className="mt-6 pt-6 border-t text-center">
          <Link href="/register" className="inline-flex items-center gap-1 text-sm text-primary hover:underline">
            <PenLine className="h-4 w-4" />
            新規登録はこちら
          </Link>
        </div>
      </CardContent>
    </Card>
  );
}
