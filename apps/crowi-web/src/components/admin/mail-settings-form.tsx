'use client';

import { useMemo, useState } from 'react';
import { CheckCircle2, Loader2, Send } from 'lucide-react';
import type { GetMailSettingsResponse, SendTestMailRequest, UpdateMailSettingsRequest } from '@crowi/api-contract';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { ErrorAlert } from '@/components/ui/error-alert';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { LoadingSpinner } from '@/components/ui/loading-spinner';
import { useAuth } from '@/lib/use-auth';
import { MailSettingsValidationFailure, useMailSettings, useSendTestMail, useUpdateMailSettings } from '@/lib/use-admin-mail-settings';
import { m } from '@paraglide/messages.js';

interface FormState {
  from: string;
  smtpHost: string;
  /** Empty string here means "not set" — converted to/from the wire's number 0. */
  smtpPort: string;
  smtpUser: string;
  smtpPassword: string;
  awsRegion: string;
  awsAccessKeyId: string;
  awsSecretAccessKey: string;
}

function toFormState(data: GetMailSettingsResponse): FormState {
  return {
    from: data.from,
    smtpHost: data.smtpHost,
    smtpPort: data.smtpPort > 0 ? String(data.smtpPort) : '',
    smtpUser: data.smtpUser,
    smtpPassword: '',
    awsRegion: data.aws.region,
    awsAccessKeyId: data.aws.accessKeyId,
    awsSecretAccessKey: '',
  };
}

interface SecretFlags {
  smtpPasswordDirty: boolean;
  smtpPasswordClearRequested: boolean;
  awsSecretDirty: boolean;
  awsSecretClearRequested: boolean;
}

function buildUpdateBody(state: FormState, initial: FormState, flags: SecretFlags): UpdateMailSettingsRequest {
  const body: UpdateMailSettingsRequest = {};

  if (state.from !== initial.from) body.from = state.from;
  if (state.smtpHost !== initial.smtpHost) body.smtpHost = state.smtpHost;
  if (state.smtpPort !== initial.smtpPort) {
    const n = state.smtpPort === '' ? NaN : Number(state.smtpPort);
    if (Number.isFinite(n)) body.smtpPort = n;
  }
  if (state.smtpUser !== initial.smtpUser) body.smtpUser = state.smtpUser;

  if (flags.smtpPasswordClearRequested) {
    body.smtpPassword = '';
  } else if (flags.smtpPasswordDirty && state.smtpPassword !== '') {
    body.smtpPassword = state.smtpPassword;
  }

  const aws: NonNullable<UpdateMailSettingsRequest['aws']> = {};
  if (state.awsRegion !== initial.awsRegion) aws.region = state.awsRegion;
  if (state.awsAccessKeyId !== initial.awsAccessKeyId) aws.accessKeyId = state.awsAccessKeyId;
  if (flags.awsSecretClearRequested) {
    aws.secretAccessKey = '';
  } else if (flags.awsSecretDirty && state.awsSecretAccessKey !== '') {
    aws.secretAccessKey = state.awsSecretAccessKey;
  }
  if (Object.keys(aws).length > 0) body.aws = aws;

  return body;
}

/**
 * Build the body for POST /admin/mail/test from the current form state. Only
 * the SMTP-relevant fields are included; the test endpoint also falls back to
 * saved values for any field omitted here.
 */
function buildTestBody(state: FormState, smtpPasswordDirty: boolean): SendTestMailRequest {
  const body: NonNullable<SendTestMailRequest> = {};
  if (state.smtpHost !== '') body.smtpHost = state.smtpHost;
  if (state.smtpPort !== '') {
    const n = Number(state.smtpPort);
    if (Number.isFinite(n)) body.smtpPort = n;
  }
  if (state.smtpUser !== '') body.smtpUser = state.smtpUser;
  if (smtpPasswordDirty && state.smtpPassword !== '') body.smtpPassword = state.smtpPassword;
  return body;
}

export function MailSettingsForm() {
  const { data, isLoading, isError, refetch } = useMailSettings();
  const update = useUpdateMailSettings();
  const sendTest = useSendTestMail();
  const { user } = useAuth();

  const [state, setState] = useState<FormState | null>(null);
  const [initial, setInitial] = useState<FormState | null>(null);
  const [hydratedFrom, setHydratedFrom] = useState<GetMailSettingsResponse | null>(null);
  const [smtpPasswordDirty, setSmtpPasswordDirty] = useState(false);
  const [smtpPasswordClearRequested, setSmtpPasswordClearRequested] = useState(false);
  const [awsSecretDirty, setAwsSecretDirty] = useState(false);
  const [awsSecretClearRequested, setAwsSecretClearRequested] = useState(false);
  const [savedAt, setSavedAt] = useState<number | null>(null);
  const [testSentAt, setTestSentAt] = useState<{ at: number; to: string } | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});

  if (data && hydratedFrom === null) {
    const next = toFormState(data);
    setState(next);
    setInitial(next);
    setHydratedFrom(data);
  }

  const isDirty = useMemo(() => {
    if (!state || !initial) return false;
    if (smtpPasswordDirty || smtpPasswordClearRequested) return true;
    if (awsSecretDirty || awsSecretClearRequested) return true;
    return (
      state.from !== initial.from ||
      state.smtpHost !== initial.smtpHost ||
      state.smtpPort !== initial.smtpPort ||
      state.smtpUser !== initial.smtpUser ||
      state.awsRegion !== initial.awsRegion ||
      state.awsAccessKeyId !== initial.awsAccessKeyId
    );
  }, [state, initial, smtpPasswordDirty, smtpPasswordClearRequested, awsSecretDirty, awsSecretClearRequested]);

  if (isLoading || !data || !state || !initial) {
    return <LoadingSpinner message={m['admin.common.loading']()} size="sm" className="py-4" />;
  }

  if (isError) {
    return (
      <ErrorAlert
        title={m['admin.mail.failed_to_load_title']()}
        message={m['admin.common.failed_to_load_body']()}
        onRetry={() => refetch()}
        retryLabel={m['admin.common.retry']()}
      />
    );
  }

  const handleSubmit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!state || !initial) return;

    setFieldErrors({});
    setTestSentAt(null);

    const body = buildUpdateBody(state, initial, {
      smtpPasswordDirty,
      smtpPasswordClearRequested,
      awsSecretDirty,
      awsSecretClearRequested,
    });

    if (Object.keys(body).length === 0) return;

    try {
      await update.mutateAsync(body);
      const cleared: FormState = { ...state, smtpPassword: '', awsSecretAccessKey: '' };
      setState(cleared);
      setInitial(cleared);
      setSmtpPasswordDirty(false);
      setSmtpPasswordClearRequested(false);
      setAwsSecretDirty(false);
      setAwsSecretClearRequested(false);
      setSavedAt(Date.now());
    } catch (err) {
      if (err instanceof MailSettingsValidationFailure) {
        setFieldErrors(err.fieldErrors);
      }
    }
  };

  const handleTestSend = async () => {
    if (!state) return;
    setTestSentAt(null);
    try {
      const result = await sendTest.mutateAsync(buildTestBody(state, smtpPasswordDirty));
      setTestSentAt({ at: Date.now(), to: result.to });
    } catch {
      // surfaced via sendTest.error below
    }
  };

  const errorOf = (key: string) => fieldErrors[key];
  const hasSmtpPassword = data.smtpPassword.hasValue;
  const hasAwsSecret = data.aws.secretAccessKey.hasValue;

  return (
    <form onSubmit={handleSubmit} className="space-y-6" noValidate>
      <Card>
        <CardHeader>
          <CardTitle>{m['admin.mail.section_from_heading']()}</CardTitle>
          <CardDescription>{m['admin.mail.section_from_lead']()}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="mail-from">{m['admin.mail.field_from_label']()}</Label>
            <Input
              id="mail-from"
              type="email"
              value={state.from}
              onChange={(e) => setState({ ...state, from: e.target.value })}
              aria-invalid={Boolean(errorOf('from'))}
              placeholder={m['admin.mail.field_from_placeholder']()}
              autoComplete="off"
              maxLength={254}
            />
            {errorOf('from') && (
              <p className="text-xs text-destructive" role="alert">
                {errorOf('from')}
              </p>
            )}
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>{m['admin.mail.section_smtp_heading']()}</CardTitle>
          <CardDescription>{m['admin.mail.section_smtp_lead']()}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
            <div className="space-y-1.5 md:col-span-2">
              <Label htmlFor="smtp-host">{m['admin.mail.field_smtp_host_label']()}</Label>
              <Input
                id="smtp-host"
                value={state.smtpHost}
                onChange={(e) => setState({ ...state, smtpHost: e.target.value })}
                aria-invalid={Boolean(errorOf('smtpHost'))}
                placeholder={m['admin.mail.field_smtp_host_placeholder']()}
                autoComplete="off"
                maxLength={255}
              />
              {errorOf('smtpHost') && (
                <p className="text-xs text-destructive" role="alert">
                  {errorOf('smtpHost')}
                </p>
              )}
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="smtp-port">{m['admin.mail.field_smtp_port_label']()}</Label>
              <Input
                id="smtp-port"
                type="number"
                inputMode="numeric"
                min={1}
                max={65535}
                value={state.smtpPort}
                onChange={(e) => setState({ ...state, smtpPort: e.target.value })}
                aria-invalid={Boolean(errorOf('smtpPort'))}
                placeholder="587"
                autoComplete="off"
              />
              {errorOf('smtpPort') && (
                <p className="text-xs text-destructive" role="alert">
                  {errorOf('smtpPort')}
                </p>
              )}
            </div>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="smtp-user">{m['admin.mail.field_smtp_user_label']()}</Label>
            <Input
              id="smtp-user"
              value={state.smtpUser}
              onChange={(e) => setState({ ...state, smtpUser: e.target.value })}
              aria-invalid={Boolean(errorOf('smtpUser'))}
              autoComplete="off"
              maxLength={255}
            />
            {errorOf('smtpUser') && (
              <p className="text-xs text-destructive" role="alert">
                {errorOf('smtpUser')}
              </p>
            )}
          </div>

          <div className="space-y-1.5">
            <div className="flex items-center justify-between">
              <Label htmlFor="smtp-password">{m['admin.mail.field_smtp_password_label']()}</Label>
              {hasSmtpPassword && !smtpPasswordClearRequested && (
                <span className="inline-flex items-center gap-1 rounded-md bg-emerald-100 px-2 py-0.5 text-xs text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-200">
                  <CheckCircle2 className="h-3 w-3" />
                  {m['admin.common.secret_saved_badge']()}
                </span>
              )}
              {smtpPasswordClearRequested && (
                <span className="inline-flex items-center gap-1 rounded-md bg-amber-100 px-2 py-0.5 text-xs text-amber-800 dark:bg-amber-900/40 dark:text-amber-200">
                  {m['admin.common.secret_clear_pending_badge']()}
                </span>
              )}
            </div>
            <Input
              id="smtp-password"
              type="password"
              value={state.smtpPassword}
              onChange={(e) => {
                setState({ ...state, smtpPassword: e.target.value });
                setSmtpPasswordDirty(true);
                setSmtpPasswordClearRequested(false);
              }}
              aria-invalid={Boolean(errorOf('smtpPassword'))}
              placeholder={hasSmtpPassword ? m['admin.common.field_secret_placeholder_set']() : m['admin.common.field_secret_placeholder_unset']()}
              autoComplete="new-password"
              disabled={smtpPasswordClearRequested}
            />
            {errorOf('smtpPassword') && (
              <p className="text-xs text-destructive" role="alert">
                {errorOf('smtpPassword')}
              </p>
            )}
            {hasSmtpPassword && (
              <div className="pt-1">
                {!smtpPasswordClearRequested ? (
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    onClick={() => {
                      setSmtpPasswordClearRequested(true);
                      setSmtpPasswordDirty(false);
                      setState({ ...state, smtpPassword: '' });
                    }}
                  >
                    {m['admin.common.secret_clear_button']()}
                  </Button>
                ) : (
                  <Button type="button" size="sm" variant="ghost" onClick={() => setSmtpPasswordClearRequested(false)}>
                    {m['admin.common.secret_clear_undo']()}
                  </Button>
                )}
              </div>
            )}
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>{m['admin.mail.section_ses_heading']()}</CardTitle>
          <CardDescription>{m['admin.mail.section_ses_lead']()}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="ses-region">{m['admin.mail.field_region_label']()}</Label>
              <Input
                id="ses-region"
                value={state.awsRegion}
                onChange={(e) => setState({ ...state, awsRegion: e.target.value })}
                aria-invalid={Boolean(errorOf('aws.region'))}
                placeholder={m['admin.mail.field_region_placeholder']()}
                autoComplete="off"
              />
              {errorOf('aws.region') && (
                <p className="text-xs text-destructive" role="alert">
                  {errorOf('aws.region')}
                </p>
              )}
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="ses-access-key">{m['admin.mail.field_access_key_label']()}</Label>
              <Input
                id="ses-access-key"
                value={state.awsAccessKeyId}
                onChange={(e) => setState({ ...state, awsAccessKeyId: e.target.value })}
                aria-invalid={Boolean(errorOf('aws.accessKeyId'))}
                autoComplete="off"
              />
              {errorOf('aws.accessKeyId') && (
                <p className="text-xs text-destructive" role="alert">
                  {errorOf('aws.accessKeyId')}
                </p>
              )}
            </div>
          </div>

          <div className="space-y-1.5">
            <div className="flex items-center justify-between">
              <Label htmlFor="ses-secret-key">{m['admin.mail.field_secret_label']()}</Label>
              {hasAwsSecret && !awsSecretClearRequested && (
                <span className="inline-flex items-center gap-1 rounded-md bg-emerald-100 px-2 py-0.5 text-xs text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-200">
                  <CheckCircle2 className="h-3 w-3" />
                  {m['admin.common.secret_saved_badge']()}
                </span>
              )}
              {awsSecretClearRequested && (
                <span className="inline-flex items-center gap-1 rounded-md bg-amber-100 px-2 py-0.5 text-xs text-amber-800 dark:bg-amber-900/40 dark:text-amber-200">
                  {m['admin.common.secret_clear_pending_badge']()}
                </span>
              )}
            </div>
            <Input
              id="ses-secret-key"
              type="password"
              value={state.awsSecretAccessKey}
              onChange={(e) => {
                setState({ ...state, awsSecretAccessKey: e.target.value });
                setAwsSecretDirty(true);
                setAwsSecretClearRequested(false);
              }}
              aria-invalid={Boolean(errorOf('aws.secretAccessKey'))}
              placeholder={hasAwsSecret ? m['admin.common.field_secret_placeholder_set']() : m['admin.common.field_secret_placeholder_unset']()}
              autoComplete="new-password"
              disabled={awsSecretClearRequested}
            />
            {errorOf('aws.secretAccessKey') && (
              <p className="text-xs text-destructive" role="alert">
                {errorOf('aws.secretAccessKey')}
              </p>
            )}
            {hasAwsSecret && (
              <div className="pt-1">
                {!awsSecretClearRequested ? (
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    onClick={() => {
                      setAwsSecretClearRequested(true);
                      setAwsSecretDirty(false);
                      setState({ ...state, awsSecretAccessKey: '' });
                    }}
                  >
                    {m['admin.common.secret_clear_button']()}
                  </Button>
                ) : (
                  <Button type="button" size="sm" variant="ghost" onClick={() => setAwsSecretClearRequested(false)}>
                    {m['admin.common.secret_clear_undo']()}
                  </Button>
                )}
              </div>
            )}
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>{m['admin.mail.section_test_heading']()}</CardTitle>
          <CardDescription>
            {user?.email ? m['admin.mail.section_test_lead_with_email']({ email: user.email }) : m['admin.mail.section_test_lead']()}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="flex flex-wrap items-center gap-3">
            <Button type="button" variant="outline" onClick={handleTestSend} disabled={sendTest.isPending || !user?.email}>
              {sendTest.isPending ? (
                <>
                  <Loader2 className="h-4 w-4 mr-1 animate-spin" />
                  {m['admin.mail.test_pending']()}
                </>
              ) : (
                <>
                  <Send className="h-4 w-4 mr-1" />
                  {m['admin.mail.test_button']()}
                </>
              )}
            </Button>
            {testSentAt !== null && !sendTest.isPending && (
              <span className="inline-flex items-center gap-1 text-sm text-emerald-700 dark:text-emerald-300">
                <CheckCircle2 className="h-4 w-4" />
                {m['admin.mail.test_success']({ to: testSentAt.to })}
              </span>
            )}
            {sendTest.isError && sendTest.error instanceof Error && (
              <span className="text-sm text-destructive" role="alert">
                {sendTest.error.message}
              </span>
            )}
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
            {m['admin.mail.success_saved']()}
          </span>
        )}
        {update.isError && !(update.error instanceof MailSettingsValidationFailure) && update.error instanceof Error && (
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
