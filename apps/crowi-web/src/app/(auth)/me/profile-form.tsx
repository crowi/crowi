'use client';

import { useState } from 'react';
import { Save } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { useUpdateProfile } from '@/lib/use-profile';
import type { UserProfileResponse, Language } from '@crowi/api-contract';

interface ProfileFormProps {
  profile: UserProfileResponse;
}

const LANGUAGE_OPTIONS: { value: Language; label: string }[] = [
  { value: 'en', label: 'English' },
  { value: 'en-US', label: 'English (US)' },
  { value: 'en-GB', label: 'English (UK)' },
  { value: 'ja', label: '日本語' },
];

export function ProfileForm({ profile }: ProfileFormProps) {
  const [formData, setFormData] = useState({
    name: profile.name,
    email: profile.email,
    lang: profile.lang,
  });
  const [errors, setErrors] = useState<string[]>([]);
  const [successMessage, setSuccessMessage] = useState<string | null>(null);

  const updateProfile = useUpdateProfile();

  const handleChange = (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => {
    const { name, value } = e.target;
    setFormData((prev) => ({ ...prev, [name]: value }));
    setErrors([]);
    setSuccessMessage(null);
  };

  const handleLanguageChange = (value: Language) => {
    setFormData((prev) => ({ ...prev, lang: value }));
    setErrors([]);
    setSuccessMessage(null);
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setErrors([]);
    setSuccessMessage(null);

    // Client-side validation
    const validationErrors: string[] = [];
    if (!formData.name.trim()) {
      validationErrors.push('名前を入力してください');
    }
    if (!formData.email.trim()) {
      validationErrors.push('メールアドレスを入力してください');
    } else if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(formData.email)) {
      validationErrors.push('有効なメールアドレスを入力してください');
    }

    if (validationErrors.length > 0) {
      setErrors(validationErrors);
      return;
    }

    try {
      await updateProfile.mutateAsync({
        userForm: {
          name: formData.name,
          email: formData.email,
          lang: formData.lang,
        },
      });
      setSuccessMessage('プロフィールを更新しました');
    } catch (err) {
      setErrors([err instanceof Error ? err.message : 'プロフィールの更新に失敗しました']);
    }
  };

  const hasChanges = formData.name !== profile.name || formData.email !== profile.email || formData.lang !== profile.lang;

  return (
    <form onSubmit={handleSubmit} className="space-y-6">
      {errors.length > 0 && (
        <Alert variant="destructive">
          <AlertDescription>
            <ul className="list-disc list-inside space-y-1">
              {errors.map((error, index) => (
                <li key={index}>{error}</li>
              ))}
            </ul>
          </AlertDescription>
        </Alert>
      )}

      {successMessage && (
        <Alert>
          <AlertDescription>{successMessage}</AlertDescription>
        </Alert>
      )}

      <div className="space-y-4">
        <div className="space-y-2">
          <Label htmlFor="name">名前</Label>
          <Input id="name" name="name" type="text" value={formData.name} onChange={handleChange} placeholder="山田 太郎" required aria-required="true" />
        </div>

        <div className="space-y-2">
          <Label htmlFor="email">メールアドレス</Label>
          <Input
            id="email"
            name="email"
            type="email"
            value={formData.email}
            onChange={handleChange}
            placeholder="user@example.com"
            required
            aria-required="true"
          />
        </div>

        <div className="space-y-2">
          <Label htmlFor="lang">言語</Label>
          <Select value={formData.lang} onValueChange={handleLanguageChange} name="lang">
            <SelectTrigger id="lang" className="w-full">
              <SelectValue placeholder="言語を選択" />
            </SelectTrigger>
            <SelectContent>
              {LANGUAGE_OPTIONS.map((option) => (
                <SelectItem key={option.value} value={option.value}>
                  {option.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <div className="space-y-2">
          <Label>ユーザー名</Label>
          <Input value={profile.username} disabled className="bg-muted" />
          <p className="text-xs text-muted-foreground">ユーザー名は変更できません</p>
        </div>

        {profile.googleId && (
          <div className="space-y-2">
            <Label>Google アカウント</Label>
            <Input value="連携済み" disabled className="bg-muted text-muted-foreground" />
          </div>
        )}

        {profile.githubId && (
          <div className="space-y-2">
            <Label>GitHub アカウント</Label>
            <Input value="連携済み" disabled className="bg-muted text-muted-foreground" />
          </div>
        )}
      </div>

      <div className="flex justify-end">
        <Button type="submit" size="lg" disabled={!hasChanges || updateProfile.isPending}>
          <Save className="mr-2" />
          {updateProfile.isPending ? '保存中...' : '変更を保存'}
        </Button>
      </div>
    </form>
  );
}
