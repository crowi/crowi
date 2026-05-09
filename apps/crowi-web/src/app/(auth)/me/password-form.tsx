'use client';

import { useState, useMemo } from 'react';
import { Save, Eye, EyeOff, Check, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { useUpdatePassword } from '@/lib/use-profile';
import type { UserProfileResponse } from '@crowi/api-contract';
import { m } from '@paraglide/messages.js';

interface PasswordFormProps {
  profile: UserProfileResponse;
}

interface PasswordRequirement {
  label: string;
  met: boolean;
}

const PASSWORD_REQUIREMENTS = {
  minLength: 8,
  maxLength: 100,
  letterRegex: /[a-zA-Z]/,
  digitRegex: /\d/,
  symbolRegex: /[!@#$%^&*()_+\-=\[\]{};':"\\|,.<>\/?`~]/,
} as const;

const validatePasswordRequirements = (password: string) => {
  return {
    hasMinLength: password.length >= PASSWORD_REQUIREMENTS.minLength,
    hasMaxLength: password.length <= PASSWORD_REQUIREMENTS.maxLength,
    hasLetter: PASSWORD_REQUIREMENTS.letterRegex.test(password),
    hasDigit: PASSWORD_REQUIREMENTS.digitRegex.test(password),
    hasSymbol: PASSWORD_REQUIREMENTS.symbolRegex.test(password),
  };
};

const isPasswordMeetingRequirements = (password: string) => {
  if (!password) return false;
  const checks = validatePasswordRequirements(password);
  return Object.values(checks).every(Boolean);
};

function PasswordRequirements({ password }: { password: string }) {
  const requirements: PasswordRequirement[] = useMemo(() => {
    const checks = validatePasswordRequirements(password);
    return [
      { label: m['me.password.req_min'](), met: checks.hasMinLength },
      { label: m['me.password.req_max'](), met: checks.hasMaxLength },
      { label: m['me.password.req_letter'](), met: checks.hasLetter },
      { label: m['me.password.req_digit'](), met: checks.hasDigit },
      { label: m['me.password.req_symbol'](), met: checks.hasSymbol },
    ];
  }, [password]);

  if (!password) {
    return null;
  }

  return (
    <div className="mt-2 space-y-1">
      <p className="text-xs text-muted-foreground mb-1">{m['me.password.requirement_intro']()}</p>
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

    if (profile.hasPassword && !formData.oldPassword) {
      validationErrors.push(m['me.password.error_old_required']());
    }

    if (!formData.newPassword) {
      validationErrors.push(m['me.password.error_new_required']());
    } else {
      const checks = validatePasswordRequirements(formData.newPassword);
      if (!checks.hasMinLength) validationErrors.push(m['me.password.error_min']());
      if (!checks.hasMaxLength) validationErrors.push(m['me.password.error_max']());
      if (!checks.hasLetter) validationErrors.push(m['me.password.error_letter']());
      if (!checks.hasDigit) validationErrors.push(m['me.password.error_digit']());
      if (!checks.hasSymbol) validationErrors.push(m['me.password.error_symbol']());
    }

    if (!formData.newPasswordConfirm) {
      validationErrors.push(m['me.password.error_confirm_required']());
    } else if (formData.newPassword !== formData.newPasswordConfirm) {
      validationErrors.push(m['me.password.error_mismatch']());
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
      setSuccessMessage(m['me.password.success_save']());
      setFormData({ oldPassword: '', newPassword: '', newPasswordConfirm: '' });
    } catch (err) {
      setErrors([err instanceof Error ? err.message : m['me.password.error_save']()]);
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
            <Label htmlFor="oldPassword">{m['me.password.field_old']()}</Label>
            <div className="relative">
              <Input
                id="oldPassword"
                name="oldPassword"
                type={showOldPassword ? 'text' : 'password'}
                value={formData.oldPassword}
                onChange={handleChange}
                placeholder={m['me.password.field_old']()}
                autoComplete="current-password"
                className="pr-10"
              />
              <button
                type="button"
                onClick={() => setShowOldPassword(!showOldPassword)}
                className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground transition-colors"
                aria-label={showOldPassword ? m['me.password.hide']() : m['me.password.show']()}
              >
                {showOldPassword ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
              </button>
            </div>
          </div>
        )}

        {!profile.hasPassword && (
          <Alert>
            <AlertDescription>{m['me.password.no_password_alert']()}</AlertDescription>
          </Alert>
        )}

        <div className="space-y-2">
          <Label htmlFor="newPassword">{m['me.password.field_new']()}</Label>
          <div className="relative">
            <Input
              id="newPassword"
              name="newPassword"
              type={showNewPassword ? 'text' : 'password'}
              value={formData.newPassword}
              onChange={handleChange}
              placeholder={m['me.password.field_new']()}
              autoComplete="new-password"
              className="pr-10"
            />
            <button
              type="button"
              onClick={() => setShowNewPassword(!showNewPassword)}
              className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground transition-colors"
              aria-label={showNewPassword ? m['me.password.hide']() : m['me.password.show']()}
            >
              {showNewPassword ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
            </button>
          </div>
          <PasswordRequirements password={formData.newPassword} />
        </div>

        <div className="space-y-2">
          <Label htmlFor="newPasswordConfirm">{m['me.password.field_new_confirm']()}</Label>
          <div className="relative">
            <Input
              id="newPasswordConfirm"
              name="newPasswordConfirm"
              type={showConfirmPassword ? 'text' : 'password'}
              value={formData.newPasswordConfirm}
              onChange={handleChange}
              placeholder={m['me.password.field_new_confirm']()}
              autoComplete="new-password"
              className="pr-10"
            />
            <button
              type="button"
              onClick={() => setShowConfirmPassword(!showConfirmPassword)}
              className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground transition-colors"
              aria-label={showConfirmPassword ? m['me.password.hide']() : m['me.password.show']()}
            >
              {showConfirmPassword ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
            </button>
          </div>
          {formData.newPasswordConfirm && formData.newPassword !== formData.newPasswordConfirm && (
            <p className="text-xs text-destructive flex items-center gap-1">
              <X className="size-3" />
              {m['me.password.match_no']()}
            </p>
          )}
          {formData.newPasswordConfirm && formData.newPassword === formData.newPasswordConfirm && (
            <p className="text-xs text-green-600 flex items-center gap-1">
              <Check className="size-3" />
              {m['me.password.match_yes']()}
            </p>
          )}
        </div>
      </div>

      <div className="flex justify-end">
        <Button type="submit" size="lg" disabled={!isFormValid || updatePassword.isPending}>
          <Save className="mr-2" />
          {updatePassword.isPending ? m['me.password.save_pending']() : m['me.password.save']()}
        </Button>
      </div>
    </form>
  );
}
