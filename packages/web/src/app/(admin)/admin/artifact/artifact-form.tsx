'use client';

import { useState } from 'react';
import { Save } from 'lucide-react';
import { ARTIFACT_MAX_BYTES_MAX, ARTIFACT_MAX_BYTES_MIN, type GetArtifactSettingsResponse } from '@crowi/api-contract';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Input } from '@/components/ui/input';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { useUpdateAdminArtifactSettings } from '@/lib/use-admin-artifact';
import { m } from '@paraglide/messages.js';

export interface ArtifactFormProps {
  settings: GetArtifactSettingsResponse;
}

const DELIVERY_MODE_LABELS: Record<GetArtifactSettingsResponse['deliveryMode'], () => string> = {
  'separate-origin': () => m['admin.artifact.status_mode_separate_origin'](),
  'same-origin': () => m['admin.artifact.status_mode_same_origin'](),
  disabled: () => m['admin.artifact.status_mode_disabled'](),
};

const SAME_ORIGIN_INACTIVE_LABELS: Record<NonNullable<GetArtifactSettingsResponse['sameOriginInactiveReason']>, () => string> = {
  'separate-origin-active': () => m['admin.artifact.status_same_origin_inactive_separate_origin_active'](),
  'client-url-unset': () => m['admin.artifact.status_same_origin_inactive_client_url_unset'](),
};

export function ArtifactForm({ settings }: ArtifactFormProps) {
  const [formData, setFormData] = useState({
    sameOriginEnabled: settings.settings.sameOriginEnabled,
    allowWebFonts: settings.settings.allowWebFonts,
    maxBytes: settings.settings.maxBytes,
  });
  const [error, setError] = useState<string | null>(null);
  const [successMessage, setSuccessMessage] = useState<string | null>(null);

  const updateSettings = useUpdateAdminArtifactSettings();
  const isDirty =
    formData.sameOriginEnabled !== settings.settings.sameOriginEnabled ||
    formData.allowWebFonts !== settings.settings.allowWebFonts ||
    formData.maxBytes !== settings.settings.maxBytes;
  const isMaxBytesInRange = formData.maxBytes >= ARTIFACT_MAX_BYTES_MIN && formData.maxBytes <= ARTIFACT_MAX_BYTES_MAX;

  const handleSameOriginChange = (checked: boolean) => {
    setFormData((prev) => ({ ...prev, sameOriginEnabled: checked }));
    setError(null);
    setSuccessMessage(null);
  };

  const handleWebFontsChange = (checked: boolean) => {
    setFormData((prev) => ({ ...prev, allowWebFonts: checked }));
    setError(null);
    setSuccessMessage(null);
  };

  const handleMaxBytesChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const parsed = Number(e.target.value);
    setFormData((prev) => ({ ...prev, maxBytes: Number.isFinite(parsed) ? parsed : prev.maxBytes }));
    setError(null);
    setSuccessMessage(null);
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!isDirty || !isMaxBytesInRange) return;
    setError(null);
    setSuccessMessage(null);

    try {
      await updateSettings.mutateAsync({
        sameOriginEnabled: formData.sameOriginEnabled,
        allowWebFonts: formData.allowWebFonts,
        maxBytes: formData.maxBytes,
      });
      setSuccessMessage(m['admin.artifact.success_saved']());
    } catch (err) {
      setError(err instanceof Error ? err.message : m['admin.artifact.failed_to_save']());
    }
  };

  return (
    <form onSubmit={handleSubmit} className="space-y-6">
      {error && (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}

      {successMessage && (
        <Alert>
          <AlertDescription>{successMessage}</AlertDescription>
        </Alert>
      )}

      <section className="space-y-3">
        <h2 className="text-lg font-semibold">{m['admin.artifact.status_heading']()}</h2>
        <dl className="grid grid-cols-1 gap-2 text-sm sm:grid-cols-2">
          <div>
            <dt className="text-muted-foreground">{m['admin.artifact.status_mode_label']()}</dt>
            <dd>{DELIVERY_MODE_LABELS[settings.deliveryMode]()}</dd>
          </div>
          <div>
            <dt className="text-muted-foreground">{m['admin.artifact.status_write_enabled_label']()}</dt>
            <dd>{settings.writeEnabled ? m['admin.artifact.status_write_enabled_yes']() : m['admin.artifact.status_write_enabled_no']()}</dd>
          </div>
          <div>
            <dt className="text-muted-foreground">{m['admin.artifact.status_artifact_origin_label']()}</dt>
            <dd>{settings.artifactOrigin ?? '—'}</dd>
          </div>
          <div>
            <dt className="text-muted-foreground">{m['admin.artifact.status_crowi_origin_label']()}</dt>
            <dd>{settings.crowiOrigin ?? '—'}</dd>
          </div>
        </dl>
        {settings.deliveryMode === 'disabled' && <p className="text-muted-foreground text-xs">{m['admin.artifact.status_disabled_hint']()}</p>}
        {settings.sameOriginInactiveReason && (
          <p className="text-muted-foreground text-xs">{SAME_ORIGIN_INACTIVE_LABELS[settings.sameOriginInactiveReason]()}</p>
        )}
      </section>

      <section className="space-y-4">
        <div>
          <h2 className="text-lg font-semibold">{m['admin.artifact.section_same_origin_heading']()}</h2>
        </div>

        {/* A-7 — always shown, regardless of the Switch's state */}
        <ul className="text-muted-foreground list-disc list-inside space-y-1 text-sm">
          <li>{m['admin.artifact.same_origin_risk_cookies']()}</li>
          <li>{m['admin.artifact.same_origin_risk_proxy']()}</li>
          <li>{m['admin.artifact.same_origin_recommend_separate_origin']()}</li>
          <li>{m['admin.artifact.same_origin_precondition_topology']()}</li>
        </ul>

        <div className="flex items-start gap-3">
          <Switch id="sameOriginEnabled" checked={formData.sameOriginEnabled} onCheckedChange={handleSameOriginChange} />
          <div className="space-y-1">
            <Label htmlFor="sameOriginEnabled" className="text-sm font-medium">
              {m['admin.artifact.field_same_origin_label']()}
            </Label>
            <p className="text-muted-foreground text-xs">{m['admin.artifact.field_same_origin_help']()}</p>
          </div>
        </div>
      </section>

      <section className="space-y-4">
        <div>
          <h2 className="text-lg font-semibold">{m['admin.artifact.section_content_heading']()}</h2>
        </div>

        <div className="flex items-start gap-3">
          <Switch id="allowWebFonts" checked={formData.allowWebFonts} onCheckedChange={handleWebFontsChange} />
          <div className="space-y-1">
            <Label htmlFor="allowWebFonts" className="text-sm font-medium">
              {m['admin.artifact.field_web_fonts_label']()}
            </Label>
            <p className="text-muted-foreground text-xs">{m['admin.artifact.field_web_fonts_help']()}</p>
          </div>
        </div>

        <div className="space-y-2">
          <Label htmlFor="maxBytes">{m['admin.artifact.field_max_bytes_label']()}</Label>
          <Input
            id="maxBytes"
            name="maxBytes"
            type="number"
            min={ARTIFACT_MAX_BYTES_MIN}
            max={ARTIFACT_MAX_BYTES_MAX}
            value={formData.maxBytes}
            onChange={handleMaxBytesChange}
            aria-invalid={!isMaxBytesInRange}
            className="max-w-xs"
          />
          {isMaxBytesInRange ? (
            <p className="text-muted-foreground text-xs">{m['admin.artifact.field_max_bytes_help']()}</p>
          ) : (
            <p className="text-xs text-destructive">{m['admin.artifact.error_max_bytes_range']()}</p>
          )}
        </div>
      </section>

      <div className="flex justify-end">
        <Button type="submit" size="lg" disabled={updateSettings.isPending || !isDirty || !isMaxBytesInRange}>
          <Save className="mr-2" />
          {updateSettings.isPending ? m['admin.common.submit_pending']() : m['admin.common.submit']()}
        </Button>
      </div>
    </form>
  );
}
