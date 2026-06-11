'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { useQueryClient } from '@tanstack/react-query';
import { AtSign, User, Mail, KeyRound } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { apiClientV2 } from '@/lib/api-client';
import { loginWithPassword } from '@/lib/auth-login';
import { installerStatusKeys } from '@/lib/use-installer-status';

export function InstallerForm() {
  const router = useRouter();
  const queryClient = useQueryClient();
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [errors, setErrors] = useState<string[]>([]);
  const [formData, setFormData] = useState({
    username: '',
    name: '',
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
      // RFC-0006 Phase 4 Batch 1 — switched from `apiClient.installer.createAdmin`
      // to `apiClientV2.installer.createAdmin.$post`. The Hono handler keeps the
      // legacy semantics: HTTP 200 with `status: 'ok' | 'error'` for the
      // create-user happy/sad path, and HTTP 400 when the app is already
      // installed (also carrying `status: 'error'`).
      const response = await apiClientV2.installer.createAdmin.$post({
        json: {
          registerForm: formData,
        },
      });

      if (response.status === 200 || response.status === 400) {
        const body = await response.json();
        if (body.status === 'ok') {
          // The app is now installed. Eagerly update the cached installer
          // status so `InstallerGate` doesn't bounce us back to /installer
          // off its `staleTime: Infinity` snapshot taken before install.
          queryClient.setQueryData(installerStatusKeys.all, { status: 'already_installed' });

          // Auto sign-in as the just-created admin and land on the admin
          // dashboard with the welcome modal trigger. `/auth/login` is now
          // reachable because install completed above. If sign-in somehow
          // fails, fall back to the login screen (install itself succeeded).
          const loginResult = await loginWithPassword(formData.email, formData.password);
          if (loginResult.ok) {
            router.push('/admin?welcome=installed');
          } else {
            router.push('/login');
          }
          return;
        } else if (body.errors) {
          setErrors(body.errors);
        } else if (body.message) {
          setErrors([body.message]);
        }
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
        <CardTitle className="text-xl text-center">管理者の作成</CardTitle>
        <CardDescription className="text-center">はじめに、管理者アカウントを作成してください。</CardDescription>
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
            <Label htmlFor="username">ユーザーID</Label>
            <div className="relative">
              <AtSign className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
              <Input
                id="username"
                name="username"
                type="text"
                placeholder="記入例: taroyama"
                value={formData.username}
                onChange={handleChange}
                className="pl-10"
                required
              />
            </div>
            <p className="text-xs text-muted-foreground">ユーザーIDは、ユーザーページのURLなどに利用されます。半角英数字と一部の記号のみ利用できます。</p>
          </div>

          <div className="space-y-2">
            <Label htmlFor="name">名前</Label>
            <div className="relative">
              <User className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
              <Input
                id="name"
                name="name"
                type="text"
                placeholder="記入例: 山田 太郎"
                value={formData.name}
                onChange={handleChange}
                className="pl-10"
                required
              />
            </div>
          </div>

          <div className="space-y-2">
            <Label htmlFor="email">メールアドレス</Label>
            <div className="relative">
              <Mail className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
              <Input id="email" name="email" type="email" placeholder="E-mail" value={formData.email} onChange={handleChange} className="pl-10" required />
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
                minLength={6}
              />
            </div>
            <p className="text-xs text-muted-foreground">パスワードは6文字以上の半角英数字または記号</p>
          </div>

          <Button type="submit" className="w-full" size="lg" disabled={isSubmitting}>
            {isSubmitting ? '作成中...' : '作成'}
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}
