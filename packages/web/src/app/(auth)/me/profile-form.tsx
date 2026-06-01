'use client';

import { useState } from 'react';
import { Save } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { useUpdateProfile } from '@/lib/use-profile';
import { errorMessage } from '@/lib/error-message';
import type { UserProfileResponse, Language } from '@crowi/api-contract';
import { m } from '@paraglide/messages.js';

interface ProfileFormProps {
  profile: UserProfileResponse;
}

// Language labels stay in their native form so a user can find their own
// language regardless of the active UI locale.
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

    const validationErrors: string[] = [];
    if (!formData.name.trim()) {
      validationErrors.push(m['me.profile.error_name_required']());
    }
    if (!formData.email.trim()) {
      validationErrors.push(m['me.profile.error_email_required']());
    } else if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(formData.email)) {
      validationErrors.push(m['me.profile.error_email_invalid']());
    }

    if (validationErrors.length > 0) {
      setErrors(validationErrors);
      return;
    }

    try {
      const requestedEmail = formData.email;
      const result = await updateProfile.mutateAsync({
        userForm: {
          name: formData.name,
          email: formData.email,
          lang: formData.lang,
        },
      });
      if (result?.emailChangePending) {
        // Email isn't applied until confirmed — revert the field to the
        // current address and tell the user a confirmation link was sent.
        setFormData((prev) => ({ ...prev, email: profile.email }));
        setSuccessMessage(m['me.profile.email_change_pending']({ email: requestedEmail }));
      } else {
        setSuccessMessage(m['me.profile.success_save']());
      }
    } catch (err) {
      // The server returns a stable `ErrorCode` (carried on the thrown error);
      // localize it via the shared map, falling back to the server English
      // message and finally a generic "save failed" string.
      const code = (err as { code?: string })?.code;
      const fallback = err instanceof Error ? err.message : m['me.profile.error_save']();
      setErrors([errorMessage(code, fallback)]);
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
          <Label htmlFor="name">{m['me.profile.field_name']()}</Label>
          <Input
            id="name"
            name="name"
            type="text"
            value={formData.name}
            onChange={handleChange}
            placeholder={m['me.profile.field_name_placeholder']()}
            required
            aria-required="true"
          />
        </div>

        <div className="space-y-2">
          <Label htmlFor="email">{m['me.profile.field_email']()}</Label>
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
          <Label htmlFor="lang">{m['me.profile.field_lang']()}</Label>
          <Select value={formData.lang} onValueChange={handleLanguageChange} name="lang">
            <SelectTrigger id="lang" className="w-full">
              <SelectValue placeholder={m['me.profile.field_lang_placeholder']()} />
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
          <Label>{m['me.profile.field_username']()}</Label>
          <Input value={profile.username} disabled className="bg-muted" />
          <p className="text-xs text-muted-foreground">{m['me.profile.field_username_note']()}</p>
        </div>

        {profile.googleId && (
          <div className="space-y-2">
            <Label>{m['me.profile.field_google']()}</Label>
            <Input value={m['me.profile.connected']()} disabled className="bg-muted text-muted-foreground" />
          </div>
        )}

        {profile.githubId && (
          <div className="space-y-2">
            <Label>{m['me.profile.field_github']()}</Label>
            <Input value={m['me.profile.connected']()} disabled className="bg-muted text-muted-foreground" />
          </div>
        )}
      </div>

      <div className="flex justify-end">
        <Button type="submit" size="lg" disabled={!hasChanges || updateProfile.isPending}>
          <Save className="mr-2" />
          {updateProfile.isPending ? m['me.profile.save_pending']() : m['me.profile.save']()}
        </Button>
      </div>
    </form>
  );
}
