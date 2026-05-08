'use client';

import { useMemo, useState } from 'react';
import { Loader2, Save, CheckCircle2 } from 'lucide-react';
import type { PluginConfigResponse, PluginField, UpdatePluginConfigRequest } from '@crowi/api-contract';
import { Button } from '@/components/ui/button';
import { ErrorAlert } from '@/components/ui/error-alert';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { Textarea } from '@/components/ui/textarea';
import { SecretField } from '@/components/admin/secret-field';
import { PluginConfigValidationError, useUpdateAdminPluginConfig } from '@/lib/use-admin-plugins';
import { m } from '@paraglide/messages.js';

interface PluginConfigFormProps {
  config: PluginConfigResponse;
}

/**
 * Schema-driven config form for a single plugin. Walks the
 * `fields` array (produced server-side from the plugin's Zod
 * configSchema) and renders one input per field, picking the control
 * by `field.kind`. Tracks dirty state per field so the secret-field
 * three-state convention (untouched / cleared / replaced) maps
 * cleanly onto the wire shape.
 */
export function PluginConfigForm({ config }: PluginConfigFormProps) {
  const update = useUpdateAdminPluginConfig(config.name);

  const initialState = useMemo(() => deriveInitialState(config), [config]);
  const [state, setState] = useState<FieldState>(initialState);
  const [savedAt, setSavedAt] = useState<number | null>(null);
  const [serverError, setServerError] = useState<string | null>(null);
  const [issues, setIssues] = useState<Map<string, string>>(new Map());

  // Defensive: surface "no config" instead of crashing if the server
  // response shape is unexpected (e.g. stale bundle, transitional
  // error path).
  if (!Array.isArray(config.fields) || config.fields.length === 0) {
    return <p className="text-muted-foreground text-sm">{m['admin.plugins.no_config']()}</p>;
  }

  const dirty = isDirty(state, initialState, config.fields);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setServerError(null);
    setIssues(new Map());
    setSavedAt(null);

    const body = buildRequest(state, config.fields);
    try {
      await update.mutateAsync(body);
      setSavedAt(Date.now());
      // Clear local "cleared / dirty" markers — the just-saved state
      // is the new baseline.
      setState(applySaved(state, config.fields));
    } catch (err) {
      if (err instanceof PluginConfigValidationError) {
        const next = new Map<string, string>();
        for (const issue of err.issues) {
          const key = issue.path.map(String).join('.');
          if (!next.has(key)) next.set(key, issue.message);
        }
        setIssues(next);
      }
      setServerError(err instanceof Error ? err.message : m['admin.plugins.save_failed']());
    }
  };

  return (
    <form onSubmit={handleSubmit} className="space-y-5">
      {serverError && <ErrorAlert message={serverError} />}

      {config.fields.map((field) => (
        <FieldRow key={field.name} field={field} state={state} setState={setState} issue={issues.get(field.name)} />
      ))}

      <div className="flex items-center justify-end gap-3 pt-2">
        {savedAt !== null && !update.isPending && !dirty && (
          <span className="inline-flex items-center gap-1 text-sm text-emerald-700 dark:text-emerald-300">
            <CheckCircle2 className="h-4 w-4" />
            {m['admin.plugins.save_succeeded']()}
          </span>
        )}
        <Button type="submit" disabled={update.isPending || !dirty}>
          {update.isPending ? <Loader2 className="h-4 w-4 mr-1 animate-spin" /> : <Save className="h-4 w-4 mr-1" />}
          {update.isPending ? m['admin.plugins.save_pending']() : m['admin.plugins.save']()}
        </Button>
      </div>
    </form>
  );
}

interface FieldRowProps {
  field: PluginField;
  state: FieldState;
  setState: React.Dispatch<React.SetStateAction<FieldState>>;
  issue: string | undefined;
}

function FieldRow({ field, state, setState, issue }: FieldRowProps) {
  const description = field.description;
  const optional = field.optional ? <span className="text-muted-foreground text-xs ml-2">{m['admin.plugins.field_optional']()}</span> : null;

  if (field.kind === 'secret') {
    const meta = state.values[field.name] as SecretFieldState | undefined;
    const labelText = field.optional ? `${field.name}  (optional)` : field.name;
    return (
      <div className="space-y-1.5">
        <SecretField
          id={`field-${field.name}`}
          label={labelText}
          value={meta?.draft ?? ''}
          hasValue={Boolean(meta?.serverHasValue)}
          dirty={Boolean(meta?.dirty)}
          clearRequested={Boolean(meta?.clearRequested)}
          onChange={(value) =>
            setState((prev) =>
              updateField(prev, field.name, (cur) => ({ ...(cur as SecretFieldState), draft: value, dirty: value !== '', clearRequested: false })),
            )
          }
          onClearRequested={() =>
            setState((prev) => updateField(prev, field.name, (cur) => ({ ...(cur as SecretFieldState), draft: '', dirty: false, clearRequested: true })))
          }
          onUndoClear={() =>
            setState((prev) => updateField(prev, field.name, (cur) => ({ ...(cur as SecretFieldState), draft: '', dirty: false, clearRequested: false })))
          }
          error={issue}
        />
        {description && <p className="text-muted-foreground text-xs">{description}</p>}
      </div>
    );
  }

  if (field.kind === 'boolean') {
    const value = Boolean(state.values[field.name]);
    return (
      <div className="flex items-start gap-3">
        <Switch id={`field-${field.name}`} checked={value} onCheckedChange={(v) => setState((prev) => setValue(prev, field.name, v))} />
        <div className="space-y-1">
          <Label htmlFor={`field-${field.name}`} className="text-sm font-medium">
            {field.name}
            {optional}
          </Label>
          {description && <p className="text-muted-foreground text-xs">{description}</p>}
          {issue && (
            <p className="text-destructive text-xs" role="alert">
              {issue}
            </p>
          )}
        </div>
      </div>
    );
  }

  if (field.kind === 'enum') {
    const value = (state.values[field.name] as string | undefined) ?? '';
    return (
      <div className="space-y-1.5">
        <Label htmlFor={`field-${field.name}`}>
          {field.name}
          {optional}
        </Label>
        <Select value={value} onValueChange={(v) => setState((prev) => setValue(prev, field.name, v))} name={field.name}>
          <SelectTrigger id={`field-${field.name}`} className="w-full max-w-md">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {field.options?.map((opt) => (
              <SelectItem key={opt} value={opt}>
                {opt}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        {description && <p className="text-muted-foreground text-xs">{description}</p>}
        {issue && (
          <p className="text-destructive text-xs" role="alert">
            {issue}
          </p>
        )}
      </div>
    );
  }

  if (field.kind === 'string-array') {
    const arr = (state.values[field.name] as string[] | undefined) ?? [];
    return (
      <div className="space-y-1.5">
        <Label htmlFor={`field-${field.name}`}>
          {field.name}
          {optional}
        </Label>
        <Textarea
          id={`field-${field.name}`}
          value={arr.join('\n')}
          onChange={(e) =>
            setState((prev) =>
              setValue(
                prev,
                field.name,
                e.target.value
                  .split('\n')
                  .map((s) => s.trim())
                  .filter((s) => s.length > 0),
              ),
            )
          }
          rows={4}
        />
        {description && <p className="text-muted-foreground text-xs">{description}</p>}
        {issue && (
          <p className="text-destructive text-xs" role="alert">
            {issue}
          </p>
        )}
      </div>
    );
  }

  // string + number fall through to the same Input (number is text+coerce)
  const isNumber = field.kind === 'number';
  const value = state.values[field.name];
  const display = value === undefined || value === null ? '' : String(value);
  return (
    <div className="space-y-1.5">
      <Label htmlFor={`field-${field.name}`}>
        {field.name}
        {optional}
      </Label>
      <Input
        id={`field-${field.name}`}
        type={isNumber ? 'number' : 'text'}
        value={display}
        onChange={(e) => {
          const raw = e.target.value;
          const next: unknown = isNumber ? (raw === '' ? null : Number(raw)) : raw;
          setState((prev) => setValue(prev, field.name, next));
        }}
        className="max-w-md"
      />
      {description && <p className="text-muted-foreground text-xs">{description}</p>}
      {issue && (
        <p className="text-destructive text-xs" role="alert">
          {issue}
        </p>
      )}
    </div>
  );
}

interface SecretFieldState {
  serverHasValue: boolean;
  draft: string;
  dirty: boolean;
  clearRequested: boolean;
}

interface FieldState {
  values: Record<string, unknown>;
}

function deriveInitialState(config: PluginConfigResponse): FieldState {
  const values: Record<string, unknown> = {};
  if (!Array.isArray(config.fields)) return { values };
  for (const field of config.fields) {
    if (field.kind === 'secret') {
      const meta = config.values[field.name] as { hasValue?: boolean } | undefined;
      const secret: SecretFieldState = {
        serverHasValue: Boolean(meta?.hasValue),
        draft: '',
        dirty: false,
        clearRequested: false,
      };
      values[field.name] = secret;
    } else {
      values[field.name] = config.values[field.name] ?? field.defaultValue ?? defaultEmptyFor(field);
    }
  }
  return { values };
}

function defaultEmptyFor(field: PluginField): unknown {
  switch (field.kind) {
    case 'boolean':
      return false;
    case 'number':
      return null;
    case 'string-array':
      return [];
    case 'enum':
      return field.options?.[0] ?? '';
    default:
      return '';
  }
}

function updateField(state: FieldState, name: string, fn: (cur: unknown) => unknown): FieldState {
  return { values: { ...state.values, [name]: fn(state.values[name]) } };
}

function setValue(state: FieldState, name: string, value: unknown): FieldState {
  return { values: { ...state.values, [name]: value } };
}

function buildRequest(state: FieldState, fields: PluginField[]): UpdatePluginConfigRequest {
  const values: Record<string, unknown> = {};
  for (const field of fields) {
    if (field.kind === 'secret') {
      const meta = state.values[field.name] as SecretFieldState;
      if (meta.clearRequested) {
        values[field.name] = '';
      } else if (meta.dirty && meta.draft !== '') {
        values[field.name] = meta.draft;
      }
      // otherwise leave it out of the body so the backend keeps the existing value
    } else {
      values[field.name] = state.values[field.name];
    }
  }
  return { values };
}

function applySaved(state: FieldState, fields: PluginField[]): FieldState {
  const next: Record<string, unknown> = { ...state.values };
  for (const field of fields) {
    if (field.kind === 'secret') {
      const meta = state.values[field.name] as SecretFieldState;
      const serverHasValue = meta.clearRequested ? false : meta.dirty ? true : meta.serverHasValue;
      next[field.name] = { serverHasValue, draft: '', dirty: false, clearRequested: false } satisfies SecretFieldState;
    }
  }
  return { values: next };
}

function isDirty(state: FieldState, initial: FieldState, fields: PluginField[]): boolean {
  for (const field of fields) {
    if (field.kind === 'secret') {
      const cur = state.values[field.name] as SecretFieldState;
      if (cur.dirty || cur.clearRequested) return true;
    } else {
      const cur = state.values[field.name];
      const init = initial.values[field.name];
      if (!shallowEqual(cur, init)) return true;
    }
  }
  return false;
}

function shallowEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
    return true;
  }
  return false;
}
