'use client';

import { useState } from 'react';
import { Save } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { useUpdateAdminShareSettings } from '@/lib/use-admin-share';
import type { ShareSettings } from '@crowi/api-contract';
import { m } from '@paraglide/messages.js';

interface ShareFormProps {
  settings: ShareSettings;
}

/**
 * Single-section form for the External Sharing toggle. Mirrors the
 * structure of `security-form.tsx` (form local state + submit-driven
 * mutation + Alert-based feedback) but with just one boolean field.
 */
export function ShareForm({ settings }: ShareFormProps) {
  const [externalShare, setExternalShare] = useState<boolean>(settings.externalShare);
  const [errors, setErrors] = useState<string[]>([]);
  const [successMessage, setSuccessMessage] = useState<string | null>(null);

  const updateSettings = useUpdateAdminShareSettings();

  const handleToggle = (next: boolean) => {
    setExternalShare(next);
    setErrors([]);
    setSuccessMessage(null);
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setErrors([]);
    setSuccessMessage(null);

    try {
      const updated = await updateSettings.mutateAsync({ externalShare });
      // Reflect the persisted value back into local state in case the server
      // ever applies coercion (today it doesn't, but stay defensive).
      setExternalShare(updated.externalShare);
      setSuccessMessage(m['admin.share.success_saved']());
    } catch (err) {
      setErrors([err instanceof Error ? err.message : m['admin.share.failed_to_save']()]);
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
          <h2 className="text-lg font-semibold">{m['admin.share.section_external_heading']()}</h2>
          <p className="text-muted-foreground text-sm">{m['admin.share.section_external_lead']()}</p>
        </div>

        <div className="flex items-start gap-3">
          <Switch id="externalShare" checked={externalShare} onCheckedChange={handleToggle} aria-label={m['admin.share.field_external_label']()} />
          <div className="space-y-1">
            <Label htmlFor="externalShare">{m['admin.share.field_external_label']()}</Label>
            <p className="text-muted-foreground text-xs">{m['admin.share.field_external_help']()}</p>
            <p className="text-xs font-medium">{externalShare ? m['admin.share.field_external_enabled']() : m['admin.share.field_external_disabled']()}</p>
          </div>
        </div>
      </section>

      <div className="flex justify-end">
        <Button type="submit" size="lg" disabled={updateSettings.isPending}>
          <Save className="mr-2" />
          {updateSettings.isPending ? m['admin.share.submit_pending']() : m['admin.share.submit']()}
        </Button>
      </div>
    </form>
  );
}
