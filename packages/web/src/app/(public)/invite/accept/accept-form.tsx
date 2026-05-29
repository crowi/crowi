'use client';

import { useEffect, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { AtSign, KeyRound, User as UserIcon } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { apiClientV2 } from '@/lib/api-client';
import { storeTokens } from '@/lib/auth-token';

export function AcceptInviteForm() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const token = searchParams.get('token');

  const [invitedEmail, setInvitedEmail] = useState<string | null>(null);
  const [tokenInvalid, setTokenInvalid] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [errors, setErrors] = useState<string[]>([]);
  const [formData, setFormData] = useState({ username: '', name: '', password: '' });

  // Preview the invite to show who it is for / detect a dead link early.
  useEffect(() => {
    if (!token) {
      setTokenInvalid(true);
      return;
    }
    let active = true;
    (async () => {
      const res = await apiClientV2.invite.accept.$get({ query: { token } });
      if (!active) return;
      if (res.status === 200) {
        const body = await res.json();
        setInvitedEmail(body.email);
      } else {
        setTokenInvalid(true);
      }
    })().catch(() => {
      if (active) setTokenInvalid(true);
    });
    return () => {
      active = false;
    };
  }, [token]);

  const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const { name, value } = e.target;
    setFormData((prev) => ({ ...prev, [name]: value }));
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!token) return;
    setIsSubmitting(true);
    setErrors([]);

    try {
      const response = await apiClientV2.invite.accept.$post({
        json: { token, username: formData.username, name: formData.name, password: formData.password },
      });

      if (response.status === 200) {
        const body = await response.json();
        storeTokens(body, body.expiresIn);
        router.push('/');
      } else {
        const body = await response.json();
        setErrors([('error' in body && body.error?.message) || '招待の受諾に失敗しました']);
      }
    } catch {
      setErrors(['サーバーとの通信中にエラーが発生しました']);
    } finally {
      setIsSubmitting(false);
    }
  };

  if (tokenInvalid) {
    return (
      <Card className="shadow-2xl">
        <CardHeader>
          <CardTitle className="text-xl text-center">招待リンクが無効です</CardTitle>
        </CardHeader>
        <CardContent>
          <Alert variant="destructive">
            <AlertDescription>この招待リンクは無効か、有効期限が切れています。管理者に再送を依頼してください。</AlertDescription>
          </Alert>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card className="shadow-2xl">
      <CardHeader className="space-y-1">
        <CardTitle className="text-xl text-center">アカウントを設定</CardTitle>
        {invitedEmail && <CardDescription className="text-center">{invitedEmail} として参加します</CardDescription>}
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
            <Label htmlFor="username">ユーザー名</Label>
            <div className="relative">
              <AtSign className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
              <Input id="username" name="username" value={formData.username} onChange={handleChange} className="pl-10" required autoComplete="username" />
            </div>
          </div>

          <div className="space-y-2">
            <Label htmlFor="name">表示名</Label>
            <div className="relative">
              <UserIcon className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
              <Input id="name" name="name" value={formData.name} onChange={handleChange} className="pl-10" required autoComplete="name" />
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
                value={formData.password}
                onChange={handleChange}
                className="pl-10"
                required
                minLength={6}
                autoComplete="new-password"
              />
            </div>
          </div>

          <Button type="submit" className="w-full" size="lg" disabled={isSubmitting}>
            {isSubmitting ? '設定中...' : 'アカウントを作成して開始'}
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}
