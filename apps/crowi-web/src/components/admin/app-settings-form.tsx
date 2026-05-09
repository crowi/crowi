'use client';

import { useMemo, useState } from 'react';
import { AlertCircle, CheckCircle2, Loader2 } from 'lucide-react';
import type { GetAppSettingsResponse, UpdateAppSettingsRequest } from '@crowi/api-contract';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { AppSettingsValidationFailure, useAppSettings, useUpdateAppSettings } from '@/lib/use-admin-app-settings';
import { m } from '@paraglide/messages.js';

/**
 * Editable subset of the App settings — the GET response also surfaces
 * read-only fields (`externalShare`, `isUploadable`, `registrationMode`) which
 * we keep out of this state and read directly from `data` when rendering.
 *
 * Storage credentials (AWS S3 region / bucket / accessKeyId / secretAccessKey)
 * used to live here too. They moved to the per-plugin settings page
 * (`/admin/plugins?name=@crowi/plugin-aws`) when the storage plugin
 * extraction landed; this form is now strictly for `app:*` keys.
 */
interface FormState {
  appTitle: string;
  appConfidential: string;
}

/**
 * Map a {@link GetAppSettingsResponse} into the form's mutable state.
 */
function toFormState(data: GetAppSettingsResponse): FormState {
  return {
    appTitle: data.app.title,
    appConfidential: data.app.confidential,
  };
}

/**
 * Diff the current form state against the server snapshot and produce a
 * partial PUT body — only changed fields are included so the API can leave the
 * rest untouched.
 */
function buildUpdateBody(state: FormState, initial: FormState): UpdateAppSettingsRequest {
  const app: NonNullable<UpdateAppSettingsRequest['app']> = {};
  if (state.appTitle !== initial.appTitle) app.title = state.appTitle;
  if (state.appConfidential !== initial.appConfidential) app.confidential = state.appConfidential;

  const body: UpdateAppSettingsRequest = {};
  if (Object.keys(app).length > 0) body.app = app;
  return body;
}

/**
 * Localise the `registrationMode` enum returned by the API. Falls back to the
 * raw key so future modes still render something readable.
 */
function formatRegistrationMode(modes: Record<string, string>): string {
  const labels: Record<string, () => string> = {
    open: () => m['admin.app.registration_mode_open'](),
    restricted: () => m['admin.app.registration_mode_restricted'](),
    closed: () => m['admin.app.registration_mode_closed'](),
  };
  // The API may shape this as { current: 'open' } or { open: 'Open' } depending
  // on legacy code paths — handle both by preferring a `current` key.
  const current = modes.current;
  if (typeof current === 'string') {
    return labels[current]?.() ?? current;
  }
  // Fallback: pick the first key we recognise.
  for (const key of Object.keys(modes)) {
    if (key in labels) return labels[key]();
  }
  return Object.values(modes)[0] ?? m['admin.app.registration_mode_unknown']();
}

export function AppSettingsForm() {
  const { data, isLoading, isError, refetch } = useAppSettings();
  const update = useUpdateAppSettings();

  const [state, setState] = useState<FormState | null>(null);
  const [initial, setInitial] = useState<FormState | null>(null);
  // Tracks which GET payload we've already hydrated from. Comparing against
  // the latest `data` during render lets us copy server values into local
  // state without an effect (which would otherwise trip
  // `react-hooks/set-state-in-effect`). Re-baselining after a save bumps this
  // by clearing it back to null + setting the new baseline in the submit handler.
  const [hydratedFrom, setHydratedFrom] = useState<GetAppSettingsResponse | null>(null);
  const [savedAt, setSavedAt] = useState<number | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});

  // Initial hydration: copy the GET payload into local state once. Doing this
  // during render (instead of in an effect) is the React-19-recommended
  // pattern for derived-from-prop initial state. We intentionally do not
  // re-sync on subsequent refetches — explicit save+invalidate handles that
  // by re-baselining inside `handleSubmit`.
  if (data?.app && hydratedFrom === null) {
    const next = toFormState(data);
    setState(next);
    setInitial(next);
    setHydratedFrom(data);
  }

  const isDirty = useMemo(() => {
    if (!state || !initial) return false;
    return state.appTitle !== initial.appTitle || state.appConfidential !== initial.appConfidential;
  }, [state, initial]);

  if (isLoading || !data?.app || !state || !initial) {
    return (
      <div className="flex items-center gap-2 text-muted-foreground text-sm">
        <Loader2 className="h-4 w-4 animate-spin" />
        {m['admin.common.loading']()}
      </div>
    );
  }

  if (isError) {
    return (
      <Alert className="border-destructive/50">
        <AlertCircle className="h-4 w-4 text-destructive" />
        <AlertTitle>{m['admin.app.failed_to_load_title']()}</AlertTitle>
        <AlertDescription className="flex items-center gap-3">
          <span>{m['admin.common.failed_to_load_body']()}</span>
          <Button size="sm" variant="outline" onClick={() => refetch()}>
            {m['admin.common.retry']()}
          </Button>
        </AlertDescription>
      </Alert>
    );
  }

  const handleSubmit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!state || !initial) return;

    setFieldErrors({});

    // Cheap client-side guard for the only field the legacy form blocked outright.
    // Server-side Zod still validates everything — this just gives faster feedback.
    if (state.appTitle.trim() === '') {
      setFieldErrors({ 'app.title': m['admin.app.field_title_required']() });
      return;
    }

    const body = buildUpdateBody(state, initial);

    // Nothing changed — avoid a no-op request.
    if (Object.keys(body).length === 0) {
      return;
    }

    try {
      await update.mutateAsync(body);
      // Re-baseline so the form is no longer "dirty" after a successful save.
      setInitial(state);
      setSavedAt(Date.now());
    } catch (err) {
      if (err instanceof AppSettingsValidationFailure) {
        setFieldErrors(err.fieldErrors);
      }
      // Other errors are surfaced via update.error below.
    }
  };

  const errorOf = (key: string) => fieldErrors[key];
  const isUploadable = data.isUploadable;

  return (
    <form onSubmit={handleSubmit} className="space-y-6" noValidate>
      {/* Card 1: 基本設定 */}
      <Card>
        <CardHeader>
          <CardTitle>{m['admin.app.section_basic_heading']()}</CardTitle>
          <CardDescription>{m['admin.app.section_basic_lead']()}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="app-title">{m['admin.app.field_title_label']()}</Label>
            <Input
              id="app-title"
              value={state.appTitle}
              onChange={(e) => setState({ ...state, appTitle: e.target.value })}
              aria-invalid={Boolean(errorOf('app.title'))}
              maxLength={100}
              required
            />
            {errorOf('app.title') && (
              <p className="text-xs text-destructive" role="alert">
                {errorOf('app.title')}
              </p>
            )}
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="app-confidential">{m['admin.app.field_confidential_label']()}</Label>
            <Textarea
              id="app-confidential"
              value={state.appConfidential}
              onChange={(e) => setState({ ...state, appConfidential: e.target.value })}
              aria-invalid={Boolean(errorOf('app.confidential'))}
              maxLength={500}
              rows={3}
              placeholder={m['admin.app.field_confidential_placeholder']()}
            />
            {errorOf('app.confidential') && (
              <p className="text-xs text-destructive" role="alert">
                {errorOf('app.confidential')}
              </p>
            )}
          </div>
        </CardContent>
      </Card>

      {/* Card 2: 表示のみのステータス */}
      <Card>
        <CardHeader>
          <CardTitle>{m['admin.app.section_status_heading']()}</CardTitle>
          <CardDescription>{m['admin.app.section_status_lead']()}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-2 text-sm">
          <div className="flex justify-between gap-4">
            <span className="text-muted-foreground">{m['admin.app.status_registration_mode']()}</span>
            <span className="font-medium">{formatRegistrationMode(data.registrationMode)}</span>
          </div>
          <div className="flex justify-between gap-4">
            <span className="text-muted-foreground">{m['admin.app.status_uploadable_label']()}</span>
            <span className="font-medium">{isUploadable ? m['admin.app.status_uploadable_yes']() : m['admin.app.status_uploadable_no']()}</span>
          </div>
          <div className="flex justify-between gap-4">
            <span className="text-muted-foreground">{m['admin.app.status_external_share_label']()}</span>
            <span className="font-medium">
              {data.app.externalShare ? m['admin.app.status_external_share_enabled']() : m['admin.app.status_external_share_disabled']()}
            </span>
          </div>
        </CardContent>
      </Card>

      <div className="flex items-center gap-3">
        <Button type="submit" disabled={!isDirty || update.isPending}>
          {update.isPending ? (
            <>
              <Loader2 className="h-4 w-4 mr-1 animate-spin" />
              {m['admin.common.submit_pending']()}
            </>
          ) : (
            m['admin.common.submit']()
          )}
        </Button>
        {savedAt !== null && !update.isPending && !isDirty && (
          <span className="inline-flex items-center gap-1 text-sm text-emerald-700 dark:text-emerald-300">
            <CheckCircle2 className="h-4 w-4" />
            {m['admin.app.success_saved']()}
          </span>
        )}
        {update.isError && !(update.error instanceof AppSettingsValidationFailure) && update.error instanceof Error && (
          <span className="text-sm text-destructive" role="alert">
            {update.error.message}
          </span>
        )}
        {Object.keys(fieldErrors).length > 0 && (
          <span className="text-sm text-destructive" role="alert">
            {m['admin.common.field_errors_summary']()}
          </span>
        )}
      </div>
    </form>
  );
}
