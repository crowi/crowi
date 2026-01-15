'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { AtSign, User, Mail, KeyRound } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { apiClient } from '@/lib/api-client';

export function InstallerForm() {
  const router = useRouter();
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
      const result = await apiClient.installer.createAdmin({
        body: {
          registerForm: formData,
        },
      });

      if (result.status === 200 || result.status === 400) {
        const body = result.body;
        if (body.status === 'ok') {
          router.push('/');
        } else if (body.errors) {
          setErrors(body.errors);
        } else if (body.message) {
          setErrors([body.message]);
        }
      } else {
        setErrors(['予期しないエラーが発生しました']);
      }
    } catch (error) {
      setErrors(['サーバーとの通信中にエラーが発生しました']);
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <Card className="shadow-2xl">
      <CardHeader className="space-y-1">
        <CardTitle className="text-xl text-center">管理者の作成</CardTitle>
        <CardDescription className="text-center">
          はじめに、管理者アカウントを作成してください。
        </CardDescription>
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
            <p className="text-xs text-muted-foreground">
              ユーザーIDは、ユーザーページのURLなどに利用されます。半角英数字と一部の記号のみ利用できます。
            </p>
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
              <Input
                id="email"
                name="email"
                type="email"
                placeholder="E-mail"
                value={formData.email}
                onChange={handleChange}
                className="pl-10"
                required
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
              />
            </div>
            <p className="text-xs text-muted-foreground">
              パスワードは6文字以上の半角英数字または記号
            </p>
          </div>

          <Button
            type="submit"
            className="w-full"
            size="lg"
            disabled={isSubmitting}
          >
            {isSubmitting ? '作成中...' : '作成'}
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}
