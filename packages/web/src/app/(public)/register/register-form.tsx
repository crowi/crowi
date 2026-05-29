'use client';

import { useState } from 'react';
import Link from 'next/link';
import { AtSign, User, Mail, KeyRound, LogIn, MailCheck } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { apiClientV2 } from '@/lib/api-client';

export function RegisterForm() {
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [errors, setErrors] = useState<string[]>([]);
  const [pending, setPending] = useState<'confirmation_required' | 'approval_required' | null>(null);
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
      // RFC-0006 Phase 4 Batch 1 — switched from
      // `apiClient.tokenAuth.tokenRegister` to
      // `apiClientV2.auth.register.$post`. Wire format unchanged.
      const response = await apiClientV2.auth.register.$post({
        json: {
          username: formData.username,
          name: formData.name,
          email: formData.email,
          password: formData.password,
        },
      });

      if (response.status === 200) {
        // Self-registration no longer auto-signs-in: the account is
        // pending email confirmation (open) or admin approval (restricted).
        const body = await response.json();
        setPending(body.status);
      } else if (response.status === 400 || response.status === 403 || response.status === 409 || response.status === 503) {
        const body = await response.json();
        setErrors([body.error?.message || '登録に失敗しました']);
      } else {
        setErrors(['予期しないエラーが発生しました']);
      }
    } catch {
      setErrors(['サーバーとの通信中にエラーが発生しました']);
    } finally {
      setIsSubmitting(false);
    }
  };

  if (pending) {
    return (
      <Card className="shadow-2xl">
        <CardHeader className="space-y-1">
          <CardTitle className="text-xl text-center">{pending === 'confirmation_required' ? 'メールを確認してください' : '登録を受け付けました'}</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <Alert>
            <MailCheck className="h-4 w-4" />
            <AlertDescription>
              {pending === 'confirmation_required'
                ? `${formData.email} 宛にアカウント有効化のメールを送信しました。メール内のリンクをクリックして登録を完了してください。`
                : '管理者の承認後にサインインできるようになります。'}
            </AlertDescription>
          </Alert>
          <Link href="/login" className="inline-flex items-center gap-1 text-sm text-primary hover:underline">
            <LogIn className="h-4 w-4" />
            サインインに戻る
          </Link>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card className="shadow-2xl">
      <CardHeader className="space-y-1">
        <CardTitle className="text-xl text-center">新規登録</CardTitle>
        <CardDescription className="text-center">アカウントを作成してください</CardDescription>
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
                autoComplete="username"
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
                autoComplete="name"
              />
            </div>
          </div>

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
                minLength={6}
                autoComplete="new-password"
              />
            </div>
            <p className="text-xs text-muted-foreground">パスワードは6文字以上の半角英数字または記号</p>
          </div>

          <Button type="submit" className="w-full" size="lg" disabled={isSubmitting}>
            {isSubmitting ? '登録中...' : '新規登録'}
          </Button>
        </form>

        <div className="mt-6 pt-6 border-t text-center">
          <Link href="/login" className="inline-flex items-center gap-1 text-sm text-primary hover:underline">
            <LogIn className="h-4 w-4" />
            サインインはこちら
          </Link>
        </div>
      </CardContent>
    </Card>
  );
}
