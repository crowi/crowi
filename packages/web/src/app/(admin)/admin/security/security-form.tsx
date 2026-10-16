'use client';

import { useState } from 'react';
import { Save } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Textarea } from '@/components/ui/textarea';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { useUpdateAdminSecuritySettings } from '@/lib/use-admin-security';
import type { RegistrationMode, SecuritySettings, UpdateSecuritySettingsRequest } from '@crowi/api-contract';
import { m } from '@paraglide/messages.js';

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
const REGISTRATION_MODE_OPTIONS: { value: RegistrationMode; label: () => string; description: () => string }[] = [
  { value: 'Open', label: () => m['admin.security.mode_open_label'](), description: () => m['admin.security.mode_open_description']() },
  { value: 'Resricted', label: () => m['admin.security.mode_restricted_label'](), description: () => m['admin.security.mode_restricted_description']() },
  { value: 'Closed', label: () => m['admin.security.mode_closed_label'](), description: () => m['admin.security.mode_closed_description']() },
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

type FormData = {
  registrationMode: RegistrationMode;
  registrationWhiteListRaw: string;
  linkCardEnabled: boolean;
  htmlSanitizationEnabled: boolean;
};

// An API that predates the setting omits it; the instance default is ON.
const toFormData = (settings: SecuritySettings): FormData => ({
  registrationMode: settings.registrationMode,
  registrationWhiteListRaw: formatWhiteList(settings.registrationWhiteList),
  linkCardEnabled: settings.linkCardEnabled,
  htmlSanitizationEnabled: (settings as Partial<SecuritySettings>).htmlSanitizationEnabled ?? true,
});

const sameList = (a: string[], b: string[]) => a.length === b.length && a.every((value, index) => value === b[index]);

/**
 * Only the fields that differ from the last-known server state are sent. The
 * settings query is cached (no refetch on focus), so re-sending an untouched
 * field would roll back another admin's change to it.
 */
const buildChanges = (formData: FormData, baseline: FormData): UpdateSecuritySettingsRequest => {
  const changes: UpdateSecuritySettingsRequest = {};
  if (formData.registrationMode !== baseline.registrationMode) changes.registrationMode = formData.registrationMode;
  const whiteList = parseWhiteList(formData.registrationWhiteListRaw);
  if (!sameList(whiteList, parseWhiteList(baseline.registrationWhiteListRaw))) changes.registrationWhiteList = whiteList;
  if (formData.linkCardEnabled !== baseline.linkCardEnabled) changes.linkCardEnabled = formData.linkCardEnabled;
  if (formData.htmlSanitizationEnabled !== baseline.htmlSanitizationEnabled) changes.htmlSanitizationEnabled = formData.htmlSanitizationEnabled;
  return changes;
};

export function SecurityForm({ settings }: SecurityFormProps) {
  const [formData, setFormData] = useState<FormData>(() => toFormData(settings));
  // The comparison source for "what changed"; replaced only by a successful save.
  const [baseline, setBaseline] = useState<FormData>(() => toFormData(settings));
  const [errors, setErrors] = useState<string[]>([]);
  const [successMessage, setSuccessMessage] = useState<string | null>(null);

  const updateSettings = useUpdateAdminSecuritySettings();
  const isPending = updateSettings.isPending;
  const changes = buildChanges(formData, baseline);
  const isDirty = Object.keys(changes).length > 0;

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

  const handleLinkCardEnabledChange = (checked: boolean) => {
    setFormData((prev) => ({ ...prev, linkCardEnabled: checked }));
    setErrors([]);
    setSuccessMessage(null);
  };

  const handleHtmlSanitizationEnabledChange = (checked: boolean) => {
    setFormData((prev) => ({ ...prev, htmlSanitizationEnabled: checked }));
    setErrors([]);
    setSuccessMessage(null);
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!isDirty || isPending) return;
    setErrors([]);
    setSuccessMessage(null);

    try {
      const updated = await updateSettings.mutateAsync(changes);
      // Reflect server-side sanitization (trim / drop empties) back into the
      // textarea so the UI matches the persisted state without a manual reload.
      const next = toFormData(updated);
      setFormData(next);
      setBaseline(next);
      setSuccessMessage(m['admin.security.success_saved']());
    } catch (err) {
      // Input and baseline stay as the admin left them so the same changes can be re-sent.
      setErrors([err instanceof Error ? err.message : m['admin.security.failed_to_save']()]);
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
          <h2 className="text-lg font-semibold">{m['admin.security.section_registration_heading']()}</h2>
          <p className="text-muted-foreground text-sm">{m['admin.security.section_registration_lead']()}</p>
        </div>

        <div className="space-y-2">
          <Label htmlFor="registrationMode">{m['admin.security.field_registration_mode']()}</Label>
          <Select value={formData.registrationMode} onValueChange={handleRegistrationModeChange} name="registrationMode" disabled={isPending}>
            <SelectTrigger id="registrationMode" className="w-full">
              <SelectValue placeholder={m['admin.security.field_registration_mode_placeholder']()} />
            </SelectTrigger>
            <SelectContent>
              {REGISTRATION_MODE_OPTIONS.map((option) => (
                <SelectItem key={option.value} value={option.value}>
                  {option.label()}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {currentModeOption && <p className="text-xs text-muted-foreground">{currentModeOption.description()}</p>}
        </div>

        <div className="space-y-2">
          <Label htmlFor="registrationWhiteListRaw">{m['admin.security.field_whitelist_label']()}</Label>
          <Textarea
            id="registrationWhiteListRaw"
            name="registrationWhiteListRaw"
            value={formData.registrationWhiteListRaw}
            onChange={handleChange}
            placeholder={m['admin.security.field_whitelist_placeholder']()}
            rows={6}
            disabled={isPending}
          />
          <p className="text-xs text-muted-foreground">{m['admin.security.field_whitelist_help']()}</p>
        </div>
      </section>

      <section className="space-y-4">
        <div>
          <h2 className="text-lg font-semibold">{m['admin.security.section_link_card_heading']()}</h2>
          <p className="text-muted-foreground text-sm">{m['admin.security.section_link_card_lead']()}</p>
        </div>

        <div className="flex items-start gap-3">
          <Switch id="linkCardEnabled" checked={formData.linkCardEnabled} onCheckedChange={handleLinkCardEnabledChange} disabled={isPending} />
          <div className="space-y-1">
            <Label htmlFor="linkCardEnabled" className="text-sm font-medium">
              {m['admin.security.field_link_card_label']()}
            </Label>
            <p className="text-muted-foreground text-xs">{m['admin.security.field_link_card_help']()}</p>
          </div>
        </div>
      </section>

      <section className="space-y-4">
        <div>
          <h2 className="text-lg font-semibold">{m['admin.security.section_html_sanitization_heading']()}</h2>
          <p className="text-muted-foreground text-sm">{m['admin.security.html_sanitization_activation_help']()}</p>
        </div>

        <div className="flex items-start gap-3">
          <Switch
            id="htmlSanitizationEnabled"
            checked={formData.htmlSanitizationEnabled}
            onCheckedChange={handleHtmlSanitizationEnabledChange}
            disabled={isPending}
          />
          <div className="space-y-1">
            <Label htmlFor="htmlSanitizationEnabled" className="text-sm font-medium">
              {m['admin.security.field_html_sanitization_label']()}
            </Label>
            <p className="text-muted-foreground text-xs">{m['admin.security.field_html_sanitization_help']()}</p>
          </div>
        </div>
      </section>

      <div className="flex justify-end">
        <Button type="submit" size="lg" disabled={isPending || !isDirty}>
          <Save className="mr-2" />
          {isPending ? m['admin.common.submit_pending']() : m['admin.common.submit']()}
        </Button>
      </div>
    </form>
  );
}
