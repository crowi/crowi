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
 */
interface FormState {
  appTitle: string;
  appConfidential: string;
  appFileUpload: boolean;
  awsRegion: string;
  awsBucket: string;
  awsAccessKeyId: string;
  /**
   * Empty string here means "no change" by default — we only forward this to
   * the API when `secretDirty` is true. The explicit-clear flow uses the
   * dedicated `secretClearRequested` flag so an empty string + dirty unambiguously
   * means "save empty".
   */
  awsSecretAccessKey: string;
}

/**
 * Map a {@link GetAppSettingsResponse} into the form's mutable state. The
 * masked secret never roundtrips through state — the input always starts empty
 * and we rely on `hasValue` to render the "already saved" hint.
 */
function toFormState(data: GetAppSettingsResponse): FormState {
  return {
    appTitle: data.app.title,
    appConfidential: data.app.confidential,
    appFileUpload: data.app.fileUpload,
    awsRegion: data.upload.aws.region,
    awsBucket: data.upload.aws.bucket,
    awsAccessKeyId: data.upload.aws.accessKeyId,
    awsSecretAccessKey: '',
  };
}

/**
 * Diff the current form state against the server snapshot and produce a
 * partial PUT body — only changed fields are included so the API can leave the
 * rest untouched. The secret has its own dirty/clear flags because an empty
 * string in the input does not by itself mean "clear it"; the operator must
 * either type a new value or hit the explicit "clear" button.
 */
function buildUpdateBody(state: FormState, initial: FormState, flags: { secretDirty: boolean; secretClearRequested: boolean }): UpdateAppSettingsRequest {
  const app: NonNullable<UpdateAppSettingsRequest['app']> = {};
  if (state.appTitle !== initial.appTitle) app.title = state.appTitle;
  if (state.appConfidential !== initial.appConfidential) app.confidential = state.appConfidential;
  if (state.appFileUpload !== initial.appFileUpload) app.fileUpload = state.appFileUpload;

  const aws: NonNullable<NonNullable<UpdateAppSettingsRequest['upload']>['aws']> = {};
  if (state.awsRegion !== initial.awsRegion) aws.region = state.awsRegion;
  if (state.awsBucket !== initial.awsBucket) aws.bucket = state.awsBucket;
  if (state.awsAccessKeyId !== initial.awsAccessKeyId) aws.accessKeyId = state.awsAccessKeyId;
  if (flags.secretClearRequested) {
    aws.secretAccessKey = '';
  } else if (flags.secretDirty && state.awsSecretAccessKey !== '') {
    aws.secretAccessKey = state.awsSecretAccessKey;
  }

  const body: UpdateAppSettingsRequest = {};
  if (Object.keys(app).length > 0) body.app = app;
  if (Object.keys(aws).length > 0) body.upload = { aws };
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
  const [secretDirty, setSecretDirty] = useState(false);
  const [secretClearRequested, setSecretClearRequested] = useState(false);
  const [savedAt, setSavedAt] = useState<number | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});

  // Initial hydration: copy the GET payload into local state once. Doing this
  // during render (instead of in an effect) is the React-19-recommended
  // pattern for derived-from-prop initial state. We intentionally do not
  // re-sync on subsequent refetches — explicit save+invalidate handles that
  // by re-baselining inside `handleSubmit`.
  //
  // The `data.app && data.upload` guard catches stale `@crowi/api-contract`
  // dist mismatches (e.g. a dev server still serving the previous contract
  // path returns a 200 with an unrelated body). Without it toFormState would
  // crash when destructuring nested fields.
  if (data?.app && data.upload && hydratedFrom === null) {
    const next = toFormState(data);
    setState(next);
    setInitial(next);
    setHydratedFrom(data);
  }

  const isDirty = useMemo(() => {
    if (!state || !initial) return false;
    if (secretDirty || secretClearRequested) return true;
    return (
      state.appTitle !== initial.appTitle ||
      state.appConfidential !== initial.appConfidential ||
      state.appFileUpload !== initial.appFileUpload ||
      state.awsRegion !== initial.awsRegion ||
      state.awsBucket !== initial.awsBucket ||
      state.awsAccessKeyId !== initial.awsAccessKeyId
    );
  }, [state, initial, secretDirty, secretClearRequested]);

  if (isLoading || !data?.app || !data.upload || !state || !initial) {
    return (
      <div className="flex items-center gap-2 text-muted-foreground text-sm">
        <Loader2 className="h-4 w-4 animate-spin" />
        {m['admin.app.loading']()}
      </div>
    );
  }

  if (isError) {
    return (
      <Alert className="border-destructive/50">
        <AlertCircle className="h-4 w-4 text-destructive" />
        <AlertTitle>{m['admin.app.failed_to_load_title']()}</AlertTitle>
        <AlertDescription className="flex items-center gap-3">
          <span>{m['admin.app.failed_to_load_body']()}</span>
          <Button size="sm" variant="outline" onClick={() => refetch()}>
            {m['admin.app.retry']()}
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

    const body = buildUpdateBody(state, initial, { secretDirty, secretClearRequested });

    // Nothing changed — avoid a no-op request.
    if (Object.keys(body).length === 0) {
      return;
    }

    try {
      await update.mutateAsync(body);
      // Re-baseline so the form is no longer "dirty" after a successful save.
      const cleared: FormState = { ...state, awsSecretAccessKey: '' };
      setState(cleared);
      setInitial(cleared);
      setSecretDirty(false);
      setSecretClearRequested(false);
      setSavedAt(Date.now());
    } catch (err) {
      if (err instanceof AppSettingsValidationFailure) {
        setFieldErrors(err.fieldErrors);
      }
      // Other errors are surfaced via update.error below.
    }
  };

  const errorOf = (key: string) => fieldErrors[key];
  const hasSecret = data.upload.aws.secretAccessKey.hasValue;
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

      {/* Card 2: ファイルアップロード */}
      <Card>
        <CardHeader>
          <CardTitle>{m['admin.app.section_upload_heading']()}</CardTitle>
          <CardDescription>{m['admin.app.section_upload_lead']()}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <label className="flex items-center gap-3 cursor-pointer">
            <input
              type="checkbox"
              className="h-4 w-4 rounded border-input accent-primary"
              checked={state.appFileUpload}
              onChange={(e) => setState({ ...state, appFileUpload: e.target.checked })}
            />
            <span className="text-sm font-medium">{m['admin.app.field_upload_toggle']()}</span>
          </label>
          {state.appFileUpload && !isUploadable && (
            <Alert className="border-amber-300 dark:border-amber-700 bg-amber-50/60 dark:bg-amber-900/20">
              <AlertCircle className="h-4 w-4 text-amber-600 dark:text-amber-400" />
              <AlertTitle className="text-amber-800 dark:text-amber-300">{m['admin.app.upload_unavailable_title']()}</AlertTitle>
              <AlertDescription className="text-amber-700 dark:text-amber-200">{m['admin.app.upload_unavailable_body']()}</AlertDescription>
            </Alert>
          )}
        </CardContent>
      </Card>

      {/* Card 3: AWS S3 */}
      <Card>
        <CardHeader>
          <CardTitle>{m['admin.app.section_aws_heading']()}</CardTitle>
          <CardDescription>{m['admin.app.section_aws_lead']()}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="aws-region">{m['admin.app.field_region_label']()}</Label>
              <Input
                id="aws-region"
                value={state.awsRegion}
                onChange={(e) => setState({ ...state, awsRegion: e.target.value })}
                aria-invalid={Boolean(errorOf('upload.aws.region'))}
                placeholder={m['admin.app.field_region_placeholder']()}
                autoComplete="off"
              />
              {errorOf('upload.aws.region') && (
                <p className="text-xs text-destructive" role="alert">
                  {errorOf('upload.aws.region')}
                </p>
              )}
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="aws-bucket">{m['admin.app.field_bucket_label']()}</Label>
              <Input
                id="aws-bucket"
                value={state.awsBucket}
                onChange={(e) => setState({ ...state, awsBucket: e.target.value })}
                aria-invalid={Boolean(errorOf('upload.aws.bucket'))}
                maxLength={63}
                autoComplete="off"
              />
              {errorOf('upload.aws.bucket') && (
                <p className="text-xs text-destructive" role="alert">
                  {errorOf('upload.aws.bucket')}
                </p>
              )}
            </div>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="aws-access-key">{m['admin.app.field_access_key_label']()}</Label>
            <Input
              id="aws-access-key"
              value={state.awsAccessKeyId}
              onChange={(e) => setState({ ...state, awsAccessKeyId: e.target.value })}
              aria-invalid={Boolean(errorOf('upload.aws.accessKeyId'))}
              autoComplete="off"
            />
            {errorOf('upload.aws.accessKeyId') && (
              <p className="text-xs text-destructive" role="alert">
                {errorOf('upload.aws.accessKeyId')}
              </p>
            )}
          </div>

          <div className="space-y-1.5">
            <div className="flex items-center justify-between">
              <Label htmlFor="aws-secret-key">{m['admin.app.field_secret_label']()}</Label>
              {hasSecret && !secretClearRequested && (
                <span className="inline-flex items-center gap-1 rounded-md bg-emerald-100 px-2 py-0.5 text-xs text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-200">
                  <CheckCircle2 className="h-3 w-3" />
                  {m['admin.app.secret_saved_badge']()}
                </span>
              )}
              {secretClearRequested && (
                <span className="inline-flex items-center gap-1 rounded-md bg-amber-100 px-2 py-0.5 text-xs text-amber-800 dark:bg-amber-900/40 dark:text-amber-200">
                  {m['admin.app.secret_clear_pending_badge']()}
                </span>
              )}
            </div>
            <Input
              id="aws-secret-key"
              type="password"
              value={state.awsSecretAccessKey}
              onChange={(e) => {
                setState({ ...state, awsSecretAccessKey: e.target.value });
                setSecretDirty(true);
                setSecretClearRequested(false);
              }}
              aria-invalid={Boolean(errorOf('upload.aws.secretAccessKey'))}
              placeholder={hasSecret ? m['admin.app.field_secret_placeholder_set']() : m['admin.app.field_secret_placeholder_unset']()}
              autoComplete="new-password"
              disabled={secretClearRequested}
            />
            {errorOf('upload.aws.secretAccessKey') && (
              <p className="text-xs text-destructive" role="alert">
                {errorOf('upload.aws.secretAccessKey')}
              </p>
            )}
            {hasSecret && (
              <div className="pt-1">
                {!secretClearRequested ? (
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    onClick={() => {
                      setSecretClearRequested(true);
                      setSecretDirty(false);
                      setState({ ...state, awsSecretAccessKey: '' });
                    }}
                  >
                    {m['admin.app.secret_clear_button']()}
                  </Button>
                ) : (
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    onClick={() => {
                      setSecretClearRequested(false);
                    }}
                  >
                    {m['admin.app.secret_clear_undo']()}
                  </Button>
                )}
              </div>
            )}
          </div>
        </CardContent>
      </Card>

      {/* Card 4: 表示のみのステータス */}
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
              {m['admin.app.submit_pending']()}
            </>
          ) : (
            m['admin.app.submit']()
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
            {m['admin.app.field_errors_summary']()}
          </span>
        )}
      </div>
    </form>
  );
}
