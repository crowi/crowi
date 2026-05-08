'use client';

import { useState } from 'react';
import { Save } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { ErrorAlert } from '@/components/ui/error-alert';
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
  const [error, setError] = useState<string | null>(null);
  const [successMessage, setSuccessMessage] = useState<string | null>(null);

  const updateSettings = useUpdateAdminShareSettings();
  const isDirty = externalShare !== settings.externalShare;

  const handleToggle = (next: boolean) => {
    setExternalShare(next);
    setError(null);
    setSuccessMessage(null);
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!isDirty) return;
    setError(null);
    setSuccessMessage(null);

    try {
      await updateSettings.mutateAsync({ externalShare });
      setSuccessMessage(m['admin.share.success_saved']());
    } catch (err) {
      setError(err instanceof Error ? err.message : m['admin.share.failed_to_save']());
    }
  };

  return (
    <form onSubmit={handleSubmit} className="space-y-6">
      {error && <ErrorAlert message={error} />}

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
        <Button type="submit" size="lg" disabled={updateSettings.isPending || !isDirty}>
          <Save className="mr-2" />
          {updateSettings.isPending ? m['admin.share.submit_pending']() : m['admin.share.submit']()}
        </Button>
      </div>
    </form>
  );
}
