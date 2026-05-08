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
      setSuccessMessage(m['admin.security.success_saved']());
    } catch (err) {
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
          <Select value={formData.registrationMode} onValueChange={handleRegistrationModeChange} name="registrationMode">
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
          />
          <p className="text-xs text-muted-foreground">{m['admin.security.field_whitelist_help']()}</p>
        </div>
      </section>

      <section className="space-y-4">
        <div>
          <h2 className="text-lg font-semibold">{m['admin.security.section_basic_heading']()}</h2>
          <p className="text-muted-foreground text-sm">{m['admin.security.section_basic_lead']()}</p>
        </div>

        <div className="space-y-2">
          <Label htmlFor="basicName">{m['admin.security.field_basic_name']()}</Label>
          <Input id="basicName" name="basicName" type="text" value={formData.basicName} onChange={handleChange} autoComplete="off" />
        </div>

        <div className="space-y-2">
          <Label htmlFor="basicSecret">{m['admin.security.field_basic_secret']()}</Label>
          <Input id="basicSecret" name="basicSecret" type="text" value={formData.basicSecret} onChange={handleChange} autoComplete="off" />
          <p className="text-xs text-muted-foreground">{m['admin.security.field_basic_secret_help']()}</p>
        </div>
      </section>

      <div className="flex justify-end">
        <Button type="submit" size="lg" disabled={updateSettings.isPending}>
          <Save className="mr-2" />
          {updateSettings.isPending ? m['admin.security.submit_pending']() : m['admin.security.submit']()}
        </Button>
      </div>
    </form>
  );
}
