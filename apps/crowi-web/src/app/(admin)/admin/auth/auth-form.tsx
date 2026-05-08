'use client';

import { useState } from 'react';
import { Save } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { AdminAuthSettingsValidationError, useUpdateAdminAuthSettings } from '@/lib/use-admin-auth-settings';
import type { AuthSettings } from '@crowi/api-contract';
import { m } from '@paraglide/messages.js';

interface AuthFormProps {
  settings: AuthSettings;
}

/**
 * Edits the two `auth:*` keys (`requireThirdPartyAuth`, `disablePasswordAuth`).
 *
 * Both keys are simple booleans driven by checkboxes. The UI surfaces an
 * advisory when `disablePasswordAuth` is toggled on, mirroring the legacy
 * server-side guard: the API will still reject the save with 422 if the
 * acting admin isn't connected to a third-party identity, but showing the
 * advisory up-front avoids the round-trip in the common case.
 */
export function AuthForm({ settings }: AuthFormProps) {
  const [formData, setFormData] = useState<AuthSettings>({
    requireThirdPartyAuth: settings.requireThirdPartyAuth,
    disablePasswordAuth: settings.disablePasswordAuth,
  });
  const [errors, setErrors] = useState<string[]>([]);
  const [successMessage, setSuccessMessage] = useState<string | null>(null);

  const updateSettings = useUpdateAdminAuthSettings();

  const handleToggle = (name: keyof AuthSettings) => (e: React.ChangeEvent<HTMLInputElement>) => {
    setFormData((prev) => ({ ...prev, [name]: e.target.checked }));
    setErrors([]);
    setSuccessMessage(null);
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setErrors([]);
    setSuccessMessage(null);

    try {
      await updateSettings.mutateAsync(formData);
      setSuccessMessage(m['admin.auth.success_saved']());
    } catch (err) {
      // The 422 self-lockout case is the only validation error this endpoint
      // returns; surface it via the localised advisory key instead of the
      // wire message so the text honours the active locale.
      if (err instanceof AdminAuthSettingsValidationError) {
        setErrors([m['admin.auth.warning_disable_password_requires_thirdparty']()]);
        return;
      }
      setErrors([err instanceof Error ? err.message : m['admin.auth.failed_to_save']()]);
    }
  };

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
          <h2 className="text-lg font-semibold">{m['admin.auth.section_password_heading']()}</h2>
          <p className="text-muted-foreground text-sm">{m['admin.auth.section_password_lead']()}</p>
        </div>

        <div className="space-y-3">
          <label className="flex items-start gap-3 cursor-pointer">
            <input
              type="checkbox"
              className="mt-1 h-4 w-4 rounded border-input accent-primary"
              checked={formData.requireThirdPartyAuth}
              onChange={handleToggle('requireThirdPartyAuth')}
            />
            <div className="space-y-1">
              <span className="text-sm font-medium">{m['admin.auth.field_require_thirdparty_auth_label']()}</span>
              <p className="text-xs text-muted-foreground">{m['admin.auth.field_require_thirdparty_auth_help']()}</p>
            </div>
          </label>

          <label className="flex items-start gap-3 cursor-pointer">
            <input
              type="checkbox"
              className="mt-1 h-4 w-4 rounded border-input accent-primary"
              checked={formData.disablePasswordAuth}
              onChange={handleToggle('disablePasswordAuth')}
            />
            <div className="space-y-1">
              <span className="text-sm font-medium">{m['admin.auth.field_disable_password_auth_label']()}</span>
              <p className="text-xs text-muted-foreground">{m['admin.auth.field_disable_password_auth_help']()}</p>
            </div>
          </label>

          {formData.disablePasswordAuth && (
            <Alert>
              <AlertDescription>{m['admin.auth.warning_disable_password_requires_thirdparty']()}</AlertDescription>
            </Alert>
          )}
        </div>
      </section>

      <div className="flex justify-end">
        <Button type="submit" size="lg" disabled={updateSettings.isPending}>
          <Save className="mr-2" />
          {updateSettings.isPending ? m['admin.common.submit_pending']() : m['admin.common.submit']()}
        </Button>
      </div>
    </form>
  );
}
