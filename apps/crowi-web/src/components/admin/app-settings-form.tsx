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
  const labels: Record<string, string> = {
    open: 'Open (誰でも登録可)',
    restricted: 'Restricted (招待のみ)',
    closed: 'Closed (登録不可)',
  };
  // The API may shape this as { current: 'open' } or { open: 'Open' } depending
  // on legacy code paths — handle both by preferring a `current` key.
  const current = modes.current;
  if (typeof current === 'string') {
    return labels[current] ?? current;
  }
  // Fallback: pick the first key we recognise.
  for (const key of Object.keys(modes)) {
    if (key in labels) return labels[key];
  }
  return Object.values(modes)[0] ?? '不明';
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
  if (data && hydratedFrom === null) {
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

  if (isLoading || !data || !state || !initial) {
    return (
      <div className="flex items-center gap-2 text-muted-foreground text-sm">
        <Loader2 className="h-4 w-4 animate-spin" />
        読み込み中...
      </div>
    );
  }

  if (isError) {
    return (
      <Alert className="border-destructive/50">
        <AlertCircle className="h-4 w-4 text-destructive" />
        <AlertTitle>設定の読み込みに失敗しました</AlertTitle>
        <AlertDescription className="flex items-center gap-3">
          <span>API への接続を確認してください。</span>
          <Button size="sm" variant="outline" onClick={() => refetch()}>
            再試行
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
      setFieldErrors({ 'app.title': 'サイト名は必須です' });
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
          <CardTitle>基本設定</CardTitle>
          <CardDescription>サイト名と機密情報の取扱についての注意書きです。</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="app-title">サイト名</Label>
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
            <Label htmlFor="app-confidential">機密情報の注意書き</Label>
            <Textarea
              id="app-confidential"
              value={state.appConfidential}
              onChange={(e) => setState({ ...state, appConfidential: e.target.value })}
              aria-invalid={Boolean(errorOf('app.confidential'))}
              maxLength={500}
              rows={3}
              placeholder="このページに記載してはいけない情報の注意書きを入力 (上部に表示されます)"
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
          <CardTitle>ファイルアップロード</CardTitle>
          <CardDescription>添付ファイル / 画像アップロード機能の有効化を切り替えます。</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <label className="flex items-center gap-3 cursor-pointer">
            <input
              type="checkbox"
              className="h-4 w-4 rounded border-input accent-primary"
              checked={state.appFileUpload}
              onChange={(e) => setState({ ...state, appFileUpload: e.target.checked })}
            />
            <span className="text-sm font-medium">ファイルアップロードを有効にする</span>
          </label>
          {state.appFileUpload && !isUploadable && (
            <Alert className="border-amber-300 dark:border-amber-700 bg-amber-50/60 dark:bg-amber-900/20">
              <AlertCircle className="h-4 w-4 text-amber-600 dark:text-amber-400" />
              <AlertTitle className="text-amber-800 dark:text-amber-300">AWS S3 設定が未完成です</AlertTitle>
              <AlertDescription className="text-amber-700 dark:text-amber-200">
                region / bucket / accessKeyId / secretAccessKey をすべて設定するまでアップロードは動作しません。
              </AlertDescription>
            </Alert>
          )}
        </CardContent>
      </Card>

      {/* Card 3: AWS S3 */}
      <Card>
        <CardHeader>
          <CardTitle>AWS S3</CardTitle>
          <CardDescription>ファイルアップロードのバックエンド (S3) の認証情報。secretAccessKey は暗号化されて保存されます。</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="aws-region">Region</Label>
              <Input
                id="aws-region"
                value={state.awsRegion}
                onChange={(e) => setState({ ...state, awsRegion: e.target.value })}
                aria-invalid={Boolean(errorOf('upload.aws.region'))}
                placeholder="ap-northeast-1"
                autoComplete="off"
              />
              {errorOf('upload.aws.region') && (
                <p className="text-xs text-destructive" role="alert">
                  {errorOf('upload.aws.region')}
                </p>
              )}
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="aws-bucket">Bucket</Label>
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
            <Label htmlFor="aws-access-key">Access Key ID</Label>
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
              <Label htmlFor="aws-secret-key">Secret Access Key</Label>
              {hasSecret && !secretClearRequested && (
                <span className="inline-flex items-center gap-1 rounded-md bg-emerald-100 px-2 py-0.5 text-xs text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-200">
                  <CheckCircle2 className="h-3 w-3" />
                  現在保存済み
                </span>
              )}
              {secretClearRequested && (
                <span className="inline-flex items-center gap-1 rounded-md bg-amber-100 px-2 py-0.5 text-xs text-amber-800 dark:bg-amber-900/40 dark:text-amber-200">
                  保存時にクリアします
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
              placeholder={hasSecret ? '変更しない場合は空のまま' : '未設定'}
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
                    保存済みシークレットをクリア
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
                    クリアを取り消す
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
          <CardTitle>ステータス</CardTitle>
          <CardDescription>関連する設定の現在値を参照表示します。</CardDescription>
        </CardHeader>
        <CardContent className="space-y-2 text-sm">
          <div className="flex justify-between gap-4">
            <span className="text-muted-foreground">登録モード</span>
            <span className="font-medium">{formatRegistrationMode(data.registrationMode)}</span>
          </div>
          <div className="flex justify-between gap-4">
            <span className="text-muted-foreground">アップロード可能</span>
            <span className="font-medium">{isUploadable ? '可' : '不可 (AWS 設定が未完成)'}</span>
          </div>
          <div className="flex justify-between gap-4">
            <span className="text-muted-foreground">外部共有</span>
            <span className="font-medium">{data.app.externalShare ? '有効' : '無効'}</span>
          </div>
        </CardContent>
      </Card>

      <div className="flex items-center gap-3">
        <Button type="submit" disabled={!isDirty || update.isPending}>
          {update.isPending ? (
            <>
              <Loader2 className="h-4 w-4 mr-1 animate-spin" />
              保存中...
            </>
          ) : (
            '変更を保存'
          )}
        </Button>
        {savedAt !== null && !update.isPending && !isDirty && (
          <span className="inline-flex items-center gap-1 text-sm text-emerald-700 dark:text-emerald-300">
            <CheckCircle2 className="h-4 w-4" />
            保存しました
          </span>
        )}
        {update.isError && !(update.error instanceof AppSettingsValidationFailure) && update.error instanceof Error && (
          <span className="text-sm text-destructive" role="alert">
            {update.error.message}
          </span>
        )}
        {Object.keys(fieldErrors).length > 0 && (
          <span className="text-sm text-destructive" role="alert">
            入力内容に誤りがあります
          </span>
        )}
      </div>
    </form>
  );
}
