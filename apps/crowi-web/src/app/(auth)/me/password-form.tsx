'use client';

import { useState, useMemo } from 'react';
import { Save, Eye, EyeOff, Check, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { useUpdatePassword } from '@/lib/use-profile';
import type { UserProfileResponse } from '@crowi/api-contract';

interface PasswordFormProps {
  profile: UserProfileResponse;
}

interface PasswordRequirement {
  label: string;
  met: boolean;
}

// Password requirements configuration
const PASSWORD_REQUIREMENTS = {
  minLength: 8,
  maxLength: 100,
  letterRegex: /[a-zA-Z]/,
  digitRegex: /\d/,
  symbolRegex: /[!@#$%^&*()_+\-=\[\]{};':"\\|,.<>\/?`~]/,
} as const;

// Validate password against all requirements
const validatePasswordRequirements = (password: string) => {
  return {
    hasMinLength: password.length >= PASSWORD_REQUIREMENTS.minLength,
    hasMaxLength: password.length <= PASSWORD_REQUIREMENTS.maxLength,
    hasLetter: PASSWORD_REQUIREMENTS.letterRegex.test(password),
    hasDigit: PASSWORD_REQUIREMENTS.digitRegex.test(password),
    hasSymbol: PASSWORD_REQUIREMENTS.symbolRegex.test(password),
  };
};

// Check if password meets all requirements
const isPasswordMeetingRequirements = (password: string) => {
  if (!password) return false;
  const checks = validatePasswordRequirements(password);
  return Object.values(checks).every(Boolean);
};

function PasswordRequirements({ password }: { password: string }) {
  const requirements: PasswordRequirement[] = useMemo(() => {
    const checks = validatePasswordRequirements(password);
    return [
      {
        label: '8文字以上',
        met: checks.hasMinLength,
      },
      {
        label: '100文字以下',
        met: checks.hasMaxLength,
      },
      {
        label: '英字を含む',
        met: checks.hasLetter,
      },
      {
        label: '数字を含む',
        met: checks.hasDigit,
      },
      {
        label: '記号を含む',
        met: checks.hasSymbol,
      },
    ];
  }, [password]);

  if (!password) {
    return null;
  }

  return (
    <div className="mt-2 space-y-1">
      <p className="text-xs text-muted-foreground mb-1">パスワード要件:</p>
      <ul className="space-y-0.5">
        {requirements.map((req) => (
          <li key={req.label} className={`flex items-center gap-1.5 text-xs ${req.met ? 'text-green-600' : 'text-muted-foreground'}`}>
            {req.met ? <Check className="size-3" /> : <X className="size-3 text-muted-foreground/50" />}
            {req.label}
          </li>
        ))}
      </ul>
    </div>
  );
}

export function PasswordForm({ profile }: PasswordFormProps) {
  const [formData, setFormData] = useState({
    oldPassword: '',
    newPassword: '',
    newPasswordConfirm: '',
  });
  const [showOldPassword, setShowOldPassword] = useState(false);
  const [showNewPassword, setShowNewPassword] = useState(false);
  const [showConfirmPassword, setShowConfirmPassword] = useState(false);
  const [errors, setErrors] = useState<string[]>([]);
  const [successMessage, setSuccessMessage] = useState<string | null>(null);

  const updatePassword = useUpdatePassword();

  const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const { name, value } = e.target;
    setFormData((prev) => ({ ...prev, [name]: value }));
    setErrors([]);
    setSuccessMessage(null);
  };

  const validateForm = (): string[] => {
    const validationErrors: string[] = [];

    // If user has password, oldPassword is required
    if (profile.hasPassword && !formData.oldPassword) {
      validationErrors.push('現在のパスワードを入力してください');
    }

    // New password validation
    if (!formData.newPassword) {
      validationErrors.push('新しいパスワードを入力してください');
    } else {
      const checks = validatePasswordRequirements(formData.newPassword);
      if (!checks.hasMinLength) {
        validationErrors.push('パスワードは8文字以上にしてください');
      }
      if (!checks.hasMaxLength) {
        validationErrors.push('パスワードは100文字以下にしてください');
      }
      if (!checks.hasLetter) {
        validationErrors.push('パスワードには英字を含めてください');
      }
      if (!checks.hasDigit) {
        validationErrors.push('パスワードには数字を含めてください');
      }
      if (!checks.hasSymbol) {
        validationErrors.push('パスワードには記号を含めてください');
      }
    }

    // Confirm password validation
    if (!formData.newPasswordConfirm) {
      validationErrors.push('新しいパスワード（確認）を入力してください');
    } else if (formData.newPassword !== formData.newPasswordConfirm) {
      validationErrors.push('新しいパスワードが一致しません');
    }

    return validationErrors;
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setErrors([]);
    setSuccessMessage(null);

    const validationErrors = validateForm();
    if (validationErrors.length > 0) {
      setErrors(validationErrors);
      return;
    }

    try {
      await updatePassword.mutateAsync({
        oldPassword: profile.hasPassword ? formData.oldPassword : undefined,
        newPassword: formData.newPassword,
        newPasswordConfirm: formData.newPasswordConfirm,
      });
      setSuccessMessage('パスワードを更新しました');
      setFormData({
        oldPassword: '',
        newPassword: '',
        newPasswordConfirm: '',
      });
    } catch (err) {
      setErrors([err instanceof Error ? err.message : 'パスワードの更新に失敗しました']);
    }
  };

  const isFormValid = useMemo(() => {
    if (profile.hasPassword && !formData.oldPassword) return false;
    if (!formData.newPassword || !formData.newPasswordConfirm) return false;
    if (formData.newPassword !== formData.newPasswordConfirm) return false;
    return isPasswordMeetingRequirements(formData.newPassword);
  }, [formData, profile.hasPassword]);

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
        {profile.hasPassword && (
          <div className="space-y-2">
            <Label htmlFor="oldPassword">現在のパスワード</Label>
            <div className="relative">
              <Input
                id="oldPassword"
                name="oldPassword"
                type={showOldPassword ? 'text' : 'password'}
                value={formData.oldPassword}
                onChange={handleChange}
                placeholder="現在のパスワード"
                autoComplete="current-password"
                className="pr-10"
              />
              <button
                type="button"
                onClick={() => setShowOldPassword(!showOldPassword)}
                className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground transition-colors"
                aria-label={showOldPassword ? 'パスワードを隠す' : 'パスワードを表示'}
              >
                {showOldPassword ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
              </button>
            </div>
          </div>
        )}

        {!profile.hasPassword && (
          <Alert>
            <AlertDescription>パスワードがまだ設定されていません。新しいパスワードを設定してください。</AlertDescription>
          </Alert>
        )}

        <div className="space-y-2">
          <Label htmlFor="newPassword">新しいパスワード</Label>
          <div className="relative">
            <Input
              id="newPassword"
              name="newPassword"
              type={showNewPassword ? 'text' : 'password'}
              value={formData.newPassword}
              onChange={handleChange}
              placeholder="新しいパスワード"
              autoComplete="new-password"
              className="pr-10"
            />
            <button
              type="button"
              onClick={() => setShowNewPassword(!showNewPassword)}
              className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground transition-colors"
              aria-label={showNewPassword ? 'パスワードを隠す' : 'パスワードを表示'}
            >
              {showNewPassword ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
            </button>
          </div>
          <PasswordRequirements password={formData.newPassword} />
        </div>

        <div className="space-y-2">
          <Label htmlFor="newPasswordConfirm">新しいパスワード（確認）</Label>
          <div className="relative">
            <Input
              id="newPasswordConfirm"
              name="newPasswordConfirm"
              type={showConfirmPassword ? 'text' : 'password'}
              value={formData.newPasswordConfirm}
              onChange={handleChange}
              placeholder="新しいパスワード（確認）"
              autoComplete="new-password"
              className="pr-10"
            />
            <button
              type="button"
              onClick={() => setShowConfirmPassword(!showConfirmPassword)}
              className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground transition-colors"
              aria-label={showConfirmPassword ? 'パスワードを隠す' : 'パスワードを表示'}
            >
              {showConfirmPassword ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
            </button>
          </div>
          {formData.newPasswordConfirm && formData.newPassword !== formData.newPasswordConfirm && (
            <p className="text-xs text-destructive flex items-center gap-1">
              <X className="size-3" />
              パスワードが一致しません
            </p>
          )}
          {formData.newPasswordConfirm && formData.newPassword === formData.newPasswordConfirm && (
            <p className="text-xs text-green-600 flex items-center gap-1">
              <Check className="size-3" />
              パスワードが一致しています
            </p>
          )}
        </div>
      </div>

      <div className="flex justify-end">
        <Button type="submit" size="lg" disabled={!isFormValid || updatePassword.isPending}>
          <Save className="mr-2" />
          {updatePassword.isPending ? '更新中...' : 'パスワードを更新'}
        </Button>
      </div>
    </form>
  );
}
