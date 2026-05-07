'use client';

import { useState } from 'react';
import { Save } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { useUpdateAdminSecuritySettings } from '@/lib/use-admin-security';
import type { RegistrationMode, SecuritySettings } from '@crowi/api-contract';

interface SecurityFormProps {
  settings: SecuritySettings;
}

/**
 * Display labels for the registrationMode enum.
 *
 * Note the historical typo: the wire value 'Resricted' (sic) is shown to
 * users as 'Restricted' (correct spelling). The mismatch is contained
 * entirely in the UI; the API still accepts and persists the legacy spelling
 * to avoid a data migration. See packages/api-contract/src/schemas/admin/security.ts.
 */
const REGISTRATION_MODE_OPTIONS: { value: RegistrationMode; label: string; description: string }[] = [
  { value: 'Open', label: 'Open (誰でも登録可能)', description: '誰でも自由に新規登録できます。' },
  { value: 'Resricted', label: 'Restricted (許可リストのみ)', description: '登録許可メールアドレスに登録されたアドレスのみ新規登録できます。' },
  { value: 'Closed', label: 'Closed (登録停止)', description: '新規登録を受け付けません。' },
];

/**
 * Convert the textarea string into the array shape expected by the API.
 *
 * Mirrors the legacy server-side `normalizeCRLFFilter` + `stringToArrayFilter`
 * logic at the client boundary: the API contract requires `string[]`, and we
 * own the textarea-to-array conversion. The server still defensively trims /
 * drops empty entries, but doing it here keeps the request body clean and
 * allows immediate UI echoing of the persisted shape.
 */
const parseWhiteList = (raw: string): string[] => {
  return raw
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .split('\n')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
};

const formatWhiteList = (list: string[]): string => list.join('\n');

export function SecurityForm({ settings }: SecurityFormProps) {
  const [formData, setFormData] = useState({
    basicName: settings.basicName,
    basicSecret: settings.basicSecret,
    registrationMode: settings.registrationMode,
    registrationWhiteListRaw: formatWhiteList(settings.registrationWhiteList),
  });
  const [errors, setErrors] = useState<string[]>([]);
  const [successMessage, setSuccessMessage] = useState<string | null>(null);

  const updateSettings = useUpdateAdminSecuritySettings();

  const handleChange = (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => {
    const { name, value } = e.target;
    setFormData((prev) => ({ ...prev, [name]: value }));
    setErrors([]);
    setSuccessMessage(null);
  };

  const handleRegistrationModeChange = (value: RegistrationMode) => {
    setFormData((prev) => ({ ...prev, registrationMode: value }));
    setErrors([]);
    setSuccessMessage(null);
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setErrors([]);
    setSuccessMessage(null);

    const whiteList = parseWhiteList(formData.registrationWhiteListRaw);

    try {
      const updated = await updateSettings.mutateAsync({
        basicName: formData.basicName,
        basicSecret: formData.basicSecret,
        registrationMode: formData.registrationMode,
        registrationWhiteList: whiteList,
      });
      // Reflect server-side sanitization (trim / drop empties) back into the
      // textarea so the UI matches the persisted state without a manual reload.
      setFormData((prev) => ({
        ...prev,
        registrationWhiteListRaw: formatWhiteList(updated.registrationWhiteList),
      }));
      setSuccessMessage('セキュリティ設定を保存しました');
    } catch (err) {
      setErrors([err instanceof Error ? err.message : 'セキュリティ設定の保存に失敗しました']);
    }
  };

  const currentModeOption = REGISTRATION_MODE_OPTIONS.find((option) => option.value === formData.registrationMode);

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

      <section className="space-y-4">
        <div>
          <h2 className="text-lg font-semibold">新規ユーザー登録</h2>
          <p className="text-muted-foreground text-sm">新規ユーザーがアカウントを作成する際の挙動を設定します。</p>
        </div>

        <div className="space-y-2">
          <Label htmlFor="registrationMode">登録モード</Label>
          <Select value={formData.registrationMode} onValueChange={handleRegistrationModeChange} name="registrationMode">
            <SelectTrigger id="registrationMode" className="w-full">
              <SelectValue placeholder="登録モードを選択" />
            </SelectTrigger>
            <SelectContent>
              {REGISTRATION_MODE_OPTIONS.map((option) => (
                <SelectItem key={option.value} value={option.value}>
                  {option.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {currentModeOption && <p className="text-xs text-muted-foreground">{currentModeOption.description}</p>}
        </div>

        <div className="space-y-2">
          <Label htmlFor="registrationWhiteListRaw">登録許可メールアドレス</Label>
          <Textarea
            id="registrationWhiteListRaw"
            name="registrationWhiteListRaw"
            value={formData.registrationWhiteListRaw}
            onChange={handleChange}
            placeholder="example.com&#10;@example.org"
            rows={6}
          />
          <p className="text-xs text-muted-foreground">
            1 行に 1 つずつ、登録を許可するメールアドレスのドメインまたはアドレスを記述します。Restricted モードでのみ評価されます。
          </p>
        </div>
      </section>

      <section className="space-y-4">
        <div>
          <h2 className="text-lg font-semibold">Basic 認証</h2>
          <p className="text-muted-foreground text-sm">設定するとサイト全体に Basic 認証が適用されます。空欄にすると無効化されます。</p>
        </div>

        <div className="space-y-2">
          <Label htmlFor="basicName">ユーザー名</Label>
          <Input id="basicName" name="basicName" type="text" value={formData.basicName} onChange={handleChange} autoComplete="off" />
        </div>

        <div className="space-y-2">
          <Label htmlFor="basicSecret">パスワード</Label>
          <Input id="basicSecret" name="basicSecret" type="text" value={formData.basicSecret} onChange={handleChange} autoComplete="off" />
          <p className="text-xs text-muted-foreground">現在の値が平文で表示されます (旧管理画面と同じ挙動)。</p>
        </div>
      </section>

      <div className="flex justify-end">
        <Button type="submit" size="lg" disabled={updateSettings.isPending}>
          <Save className="mr-2" />
          {updateSettings.isPending ? '保存中...' : '変更を保存'}
        </Button>
      </div>
    </form>
  );
}
