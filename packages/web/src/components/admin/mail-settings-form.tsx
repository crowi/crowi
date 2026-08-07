'use client';

import { useMemo, useState } from 'react';
import Link from 'next/link';
import { CheckCircle2, Loader2, Send } from 'lucide-react';
import type { UpdateMailSettingsRequest } from '@crowi/api-contract';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { ErrorAlert } from '@/components/ui/error-alert';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { LoadingSpinner } from '@/components/ui/loading-spinner';
import { errorMessage } from '@/lib/error-message';
import { useAuth } from '@/lib/use-auth';
import { MailSettingsValidationFailure, MailTestFailure, useMailSettings, useSendTestMail, useUpdateMailSettings } from '@/lib/use-admin-mail-settings';
import { m } from '@paraglide/messages.js';

export function MailSettingsForm() {
  const { data, isLoading, isError, refetch } = useMailSettings();
  const update = useUpdateMailSettings();
  const sendTest = useSendTestMail();
  const { user } = useAuth();

  const [from, setFrom] = useState<string | null>(null);
  const [initialFrom, setInitialFrom] = useState<string | null>(null);
  const [savedAt, setSavedAt] = useState<number | null>(null);
  const [testSentAt, setTestSentAt] = useState<{ at: number; to: string } | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});

  if (data && initialFrom === null) {
    setFrom(data.from);
    setInitialFrom(data.from);
  }

  const isDirty = useMemo(() => from !== null && initialFrom !== null && from !== initialFrom, [from, initialFrom]);

  if (isLoading || !data || from === null) {
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
    if (!isDirty) return;

    setFieldErrors({});
    setTestSentAt(null);

    const body: UpdateMailSettingsRequest = { from };
    try {
      await update.mutateAsync(body);
      setInitialFrom(from);
      setSavedAt(Date.now());
    } catch (err) {
      if (err instanceof MailSettingsValidationFailure) {
        setFieldErrors(err.fieldErrors);
      }
    }
  };

  const handleTestSend = async () => {
    setTestSentAt(null);
    try {
      const result = await sendTest.mutateAsync();
      setTestSentAt({ at: Date.now(), to: result.to });
    } catch {
      // surfaced via sendTest.error below
    }
  };

  const fromError = fieldErrors.from;
  const activeDriver = data.activeDriver;
  // Link straight to the active sender's config page when we know which
  // plugin registered it; otherwise fall back to the plugin list.
  const pluginSettingsHref = data.activePlugin ? `/admin/plugins/edit?name=${encodeURIComponent(data.activePlugin)}` : '/admin/plugins';

  // feature-core-config-readiness-and-mail — localize the test-send error
  // by its machine-readable `code` (never the wire `message`), and show a
  // dedicated "go set it" link when the sender address itself is unset.
  const testFailure = sendTest.error instanceof MailTestFailure ? sendTest.error : null;
  const testErrorMessage = testFailure ? errorMessage(testFailure.code) : sendTest.error instanceof Error ? sendTest.error.message : undefined;

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
              value={from}
              onChange={(e) => setFrom(e.target.value)}
              aria-invalid={Boolean(fromError)}
              placeholder={m['admin.mail.field_from_placeholder']()}
              autoComplete="off"
              maxLength={254}
            />
            {fromError && (
              <p className="text-xs text-destructive" role="alert">
                {fromError}
              </p>
            )}
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>{m['admin.mail.section_sender_heading']()}</CardTitle>
          <CardDescription>{m['admin.mail.section_sender_lead']()}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="space-y-1.5">
            <Label>{m['admin.mail.active_driver_label']()}</Label>
            {activeDriver ? (
              <code className="inline-flex rounded bg-muted px-2 py-1 text-sm">{activeDriver}</code>
            ) : (
              <p className="text-sm text-destructive">{m['admin.mail.no_active_driver']()}</p>
            )}
          </div>
          <Button type="button" variant="outline" size="sm" asChild>
            <Link href={pluginSettingsHref}>{m['admin.mail.plugins_link']()}</Link>
          </Button>
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
            {sendTest.isError && testErrorMessage && (
              <span className="text-sm text-destructive" role="alert">
                {testErrorMessage}
                {testFailure?.code === 'MAIL_FROM_NOT_CONFIGURED' && (
                  <>
                    {' '}
                    <Link href="/admin/mail" className="underline underline-offset-2 hover:no-underline">
                      {m['admin.mail.test_failed_from_link']()}
                    </Link>
                  </>
                )}
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
