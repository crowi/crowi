import type { PropsWithChildren } from 'react';
import type { PluginConfigResponse } from '@crowi/api-contract';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { makeApiResponse } from '@/lib/test-utils/mocks';

// Pure component test: `useUpdateAdminPluginConfig` is mocked (matches
// `mail-settings-form.test.tsx`'s pattern), but the REAL
// `LinkedIdentitiesExistError` / `PluginConfigValidationError` classes are
// kept via `importActual` so the component's own `instanceof` checks behave
// correctly. `realUseUpdateAdminPluginConfig` stashes the un-mocked hook so
// the one "real mutation" test below (AC-7) can delegate to it instead of
// the isPending-simulating mock — its pending state then comes from an
// actual `useMutation`, not a hand-rolled effect.
const { useUpdateAdminPluginConfig, mutateAsync, realUseUpdateAdminPluginConfig, updateConfigPut } = vi.hoisted(() => ({
  useUpdateAdminPluginConfig: vi.fn(),
  mutateAsync: vi.fn(),
  realUseUpdateAdminPluginConfig: { current: null as unknown },
  updateConfigPut: vi.fn(),
}));
vi.mock('@/lib/use-admin-plugins', async () => {
  const actual = await vi.importActual<typeof import('@/lib/use-admin-plugins')>('@/lib/use-admin-plugins');
  realUseUpdateAdminPluginConfig.current = actual.useUpdateAdminPluginConfig;
  return { ...actual, useUpdateAdminPluginConfig };
});
// Only the wire layer underneath the real hook is mocked here (mirrors
// `use-admin-plugins.test.tsx`'s own `vi.mock('./api-client', ...)`
// pattern) — `acquireRefreshedToken` / `apiBaseUrl` are stubbed too since
// `PluginActionButton` imports them at module scope, though no test here
// clicks "Run action".
vi.mock('@/lib/api-client', () => ({
  apiClient: { admin: { plugins: { config: { $put: updateConfigPut } } } },
  acquireRefreshedToken: vi.fn(),
  apiBaseUrl: vi.fn(() => 'http://localhost/api'),
}));

import { LinkedIdentitiesExistError } from '@/lib/use-admin-plugins';
import { PluginConfigForm } from './plugin-config-form';

type UseUpdateAdminPluginConfig = typeof import('@/lib/use-admin-plugins').useUpdateAdminPluginConfig;

function realMutationWrapper() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  function Wrapper({ children }: PropsWithChildren) {
    return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  }
  return Wrapper;
}

function makeConfig(): PluginConfigResponse {
  return {
    name: '@crowi/plugin-synth-auth-test',
    fields: [{ name: 'clientId', kind: 'string', optional: false }],
    values: { clientId: 'old-id' },
  };
}

/** A single secret field — used for a couple of the verification-notice tests below alongside `makeConfig()`'s plain string field (see the dirty-baseline test), to cover both the secret and non-secret `applySaved` paths. */
function makeSecretConfig(): PluginConfigResponse {
  return {
    name: '@crowi/plugin-synth-auth-test',
    fields: [{ name: 'apiKey', kind: 'secret', optional: false }],
    values: { apiKey: { hasValue: false } },
  };
}

/** One field of every control kind `FieldRow` renders — feature-plugin-config-live-verification AC-7's disable propagation must reach all of them. */
function makeMultiFieldConfig(): PluginConfigResponse {
  return {
    name: '@crowi/plugin-verification-test',
    fields: [
      { name: 'text', kind: 'string', optional: false },
      { name: 'secretValue', kind: 'secret', optional: false },
      { name: 'flag', kind: 'boolean', optional: false },
      { name: 'mode', kind: 'enum', optional: false, options: ['a', 'b'] },
      { name: 'items', kind: 'string-array', optional: false },
      { name: 'doThing', kind: 'string', optional: false, action: { label: 'Run action', method: 'POST', path: '/run' } },
    ],
    values: { text: 'hello', secretValue: { hasValue: true }, flag: true, mode: 'a', items: [] },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  useUpdateAdminPluginConfig.mockReturnValue({ mutateAsync, isPending: false });
});

afterEach(cleanup);

describe('PluginConfigForm — linked-identities confirmation dialog (feature-auth-plugin-credential-change-guard AC-7)', () => {
  it('shows the count-bearing confirmation dialog when the save is rejected with LinkedIdentitiesExistError, without saving', async () => {
    mutateAsync.mockRejectedValueOnce(new LinkedIdentitiesExistError('3 users are linked', 3));

    render(<PluginConfigForm config={makeConfig()} />);
    fireEvent.change(screen.getByLabelText('clientId'), { target: { value: 'new-id' } });
    fireEvent.click(screen.getByRole('button', { name: '変更を保存' }));

    await waitFor(() => expect(screen.getByText('連携中のユーザーがいます')).toBeInTheDocument());
    expect(
      screen.getByText('3 人がこのプロバイダと連携しています。認証情報を変更すると、この人たちがサインインできなくなる可能性があります。'),
    ).toBeInTheDocument();
    expect(mutateAsync).toHaveBeenCalledTimes(1);
  });

  it('re-sends the same values with confirmLinkedIdentities: true when confirmed, and saves', async () => {
    mutateAsync.mockRejectedValueOnce(new LinkedIdentitiesExistError('1 user is linked', 1));
    mutateAsync.mockResolvedValueOnce({ ok: true, hotReloaded: true, reconfigureFailed: false });

    render(<PluginConfigForm config={makeConfig()} />);
    fireEvent.change(screen.getByLabelText('clientId'), { target: { value: 'new-id' } });
    fireEvent.click(screen.getByRole('button', { name: '変更を保存' }));

    await waitFor(() => expect(screen.getByText('連携中のユーザーがいます')).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: '変更する' }));

    await waitFor(() => expect(mutateAsync).toHaveBeenCalledTimes(2));
    expect(mutateAsync).toHaveBeenNthCalledWith(2, { values: { clientId: 'new-id' }, confirmLinkedIdentities: true });
    await waitFor(() => expect(screen.queryByText('連携中のユーザーがいます')).not.toBeInTheDocument());
  });

  it('cancelling closes the dialog without resending, and keeps the edited input value', async () => {
    mutateAsync.mockRejectedValueOnce(new LinkedIdentitiesExistError('1 user is linked', 1));

    render(<PluginConfigForm config={makeConfig()} />);
    fireEvent.change(screen.getByLabelText('clientId'), { target: { value: 'new-id' } });
    fireEvent.click(screen.getByRole('button', { name: '変更を保存' }));

    await waitFor(() => expect(screen.getByText('連携中のユーザーがいます')).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: 'キャンセル' }));

    await waitFor(() => expect(screen.queryByText('連携中のユーザーがいます')).not.toBeInTheDocument());
    expect(mutateAsync).toHaveBeenCalledTimes(1);
    expect(screen.getByLabelText('clientId')).toHaveValue('new-id');
  });
});

describe('PluginConfigForm — in-flight disable propagation (feature-plugin-config-live-verification AC-7)', () => {
  it('disables every field control and the submit button while the mutation is pending', () => {
    useUpdateAdminPluginConfig.mockReturnValue({ mutateAsync, isPending: true });

    render(<PluginConfigForm config={makeMultiFieldConfig()} />);

    expect(screen.getByLabelText('text')).toBeDisabled();
    expect(screen.getByLabelText('secretValue')).toBeDisabled();
    expect(screen.getByLabelText('flag')).toBeDisabled();
    expect(screen.getByLabelText('mode')).toBeDisabled();
    expect(screen.getByLabelText('items')).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Run action' })).toBeDisabled();
    // SecretField's own Clear button (hasValue: true in makeMultiFieldConfig).
    expect(screen.getByRole('button', { name: '保存済みシークレットをクリア' })).toBeDisabled();
    expect(screen.getByRole('button', { name: '保存中...' })).toBeDisabled();
  });

  it('AC-7: a REAL TanStack mutation (no isPending simulation) disables every control — including SecretField Undo — throughout the actual pending -> settled transition, and S1 completing applies exactly what S1 sent', async () => {
    // Unlike the test above (which injects `isPending: true` as a fixed
    // prop) and unlike a hand-rolled `useState` wrapper around
    // `mutateAsync`, this delegates to the ACTUAL `useUpdateAdminPluginConfig`
    // (mocked only at the wire boundary — `apiClient.admin.plugins.config.$put`
    // — the same seam `use-admin-plugins.test.tsx` mocks at), rendered under
    // a real `QueryClientProvider`. `isPending` here is genuine
    // `useMutation` internal state, not something this test manufactures.
    let resolvePut: ((value: unknown) => void) | undefined;
    updateConfigPut.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolvePut = resolve;
        }),
    );
    useUpdateAdminPluginConfig.mockImplementation((name: string) => (realUseUpdateAdminPluginConfig.current as UseUpdateAdminPluginConfig)(name));

    render(<PluginConfigForm config={makeMultiFieldConfig()} />, { wrapper: realMutationWrapper() });

    // Set up SecretField's "Undo clear" button (only rendered once a clear
    // is requested) while the form is still idle.
    fireEvent.click(screen.getByRole('button', { name: '保存済みシークレットをクリア' }));
    expect(screen.getByRole('button', { name: 'クリアを取り消す' })).toBeEnabled();

    fireEvent.change(screen.getByLabelText('text'), { target: { value: 'S1-value' } });
    fireEvent.click(screen.getByRole('button', { name: '変更を保存' }));

    await waitFor(() => expect(screen.getByLabelText('text')).toBeDisabled());
    expect(screen.getByLabelText('secretValue')).toBeDisabled();
    expect(screen.getByLabelText('flag')).toBeDisabled();
    expect(screen.getByLabelText('mode')).toBeDisabled();
    expect(screen.getByLabelText('items')).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Run action' })).toBeDisabled();
    // The Undo button specifically — not covered by the static-mock test
    // above, and the one AC-7 case the review flagged as missing.
    expect(screen.getByRole('button', { name: 'クリアを取り消す' })).toBeDisabled();
    expect(updateConfigPut).toHaveBeenCalledTimes(1);

    resolvePut?.(makeApiResponse(200, { ok: true, hotReloaded: true, reconfigureFailed: false, verificationResults: [] }));
    await waitFor(() => expect(screen.getByLabelText('text')).not.toBeDisabled());

    // S1 completing applied exactly the value S1 itself sent — every
    // control was disabled for the whole in-flight window above, so there
    // was no point at which a second edit could have raced it. (The Undo
    // button itself is gone now, not just re-enabled — the clear it
    // guarded was part of what S1 just persisted, so `hasValue` flips to
    // false and `SecretField` stops rendering the Clear/Undo row entirely.)
    expect(screen.getByLabelText('text')).toHaveValue('S1-value');
    expect(screen.queryByRole('button', { name: 'クリアを取り消す' })).not.toBeInTheDocument();
  });

  it('disables every field control while the linked-identities confirmation dialog is open, even though the mutation itself has already settled (not isPending)', async () => {
    mutateAsync.mockRejectedValueOnce(new LinkedIdentitiesExistError('1 user is linked', 1));

    render(<PluginConfigForm config={makeMultiFieldConfig()} />);
    fireEvent.change(screen.getByLabelText('text'), { target: { value: 'changed' } });
    fireEvent.click(screen.getByRole('button', { name: '変更を保存' }));

    await waitFor(() => expect(screen.getByText('連携中のユーザーがいます')).toBeInTheDocument());

    // The mutation already rejected and settled — isPending is false — yet
    // every field must still be disabled because the confirmation dialog
    // it opened is showing (§ "in-flight" = isPending OR dialog open).
    expect(screen.getByLabelText('text')).toBeDisabled();
    expect(screen.getByLabelText('secretValue')).toBeDisabled();
    expect(screen.getByLabelText('flag')).toBeDisabled();
    expect(screen.getByLabelText('mode')).toBeDisabled();
    expect(screen.getByLabelText('items')).toBeDisabled();
    // Radix's modal Dialog marks the rest of the page `aria-hidden`/inert
    // while open, which is itself already sufficient to make it
    // unreachable — `getByRole` excludes hidden elements by default, so
    // `{ hidden: true }` is needed here purely to reach in and assert
    // that OUR OWN `disabled` attribute is set too (the contract this
    // test is about is "impossible independent of the dialog's own
    // modality default" — see the component's doc comment).
    expect(screen.getByRole('button', { name: 'Run action', hidden: true })).toBeDisabled();
  });
});

describe('PluginConfigForm — verification notice (feature-plugin-config-live-verification AC-8/AC-10/AC-13)', () => {
  it('AC-8/AC-10: renders fixed translations only for an ok result and each of the 5 failure reasons, plus the instance-scope caveat', async () => {
    mutateAsync.mockResolvedValueOnce({
      ok: true,
      hotReloaded: true,
      reconfigureFailed: false,
      verificationResults: [
        { plugin: 'svc-1', status: 'ok' },
        { plugin: 'svc-2', status: 'failed', reason: 'unreachable' },
        { plugin: 'svc-3', status: 'failed', reason: 'auth-failed' },
        { plugin: 'svc-4', status: 'failed', reason: 'resource-missing' },
        { plugin: 'svc-5', status: 'failed', reason: 'write-denied' },
        { plugin: 'svc-6', status: 'failed', reason: 'unknown' },
      ],
    });

    render(<PluginConfigForm config={makeSecretConfig()} />);
    fireEvent.change(screen.getByLabelText('apiKey'), { target: { value: 'new-secret' } });
    fireEvent.click(screen.getByRole('button', { name: '変更を保存' }));

    await waitFor(() => expect(screen.getByText('svc-1: 接続を確認しました')).toBeInTheDocument());
    expect(screen.getByText('svc-2: 保存済みですが検証に失敗しました (接続できませんでした)')).toBeInTheDocument();
    expect(screen.getByText('svc-3: 保存済みですが検証に失敗しました (認証に失敗しました)')).toBeInTheDocument();
    expect(screen.getByText('svc-4: 保存済みですが検証に失敗しました (対象が見つかりません)')).toBeInTheDocument();
    expect(screen.getByText('svc-5: 保存済みですが検証に失敗しました (書き込み権限がありません)')).toBeInTheDocument();
    expect(screen.getByText('svc-6: 保存済みですが検証に失敗しました (不明なエラー)')).toBeInTheDocument();
    const notice = screen.getByRole('status');
    expect(notice).toHaveTextContent('この結果は、このリクエストを処理したインスタンスでの検証結果です。他のインスタンスでの結果は含みません。');

    // Never the raw wire enum value leaking as visible text — only the
    // fixed Japanese translations above.
    expect(notice.textContent).not.toMatch(/unreachable|auth-failed|resource-missing|write-denied/i);
  });

  it('AC-13: the confirmed resend renders the same verification notice a normal successful save would', async () => {
    mutateAsync.mockRejectedValueOnce(new LinkedIdentitiesExistError('1 user is linked', 1));
    mutateAsync.mockResolvedValueOnce({
      ok: true,
      hotReloaded: true,
      reconfigureFailed: false,
      verificationResults: [{ plugin: '@crowi/plugin-synth-auth-test', status: 'ok' }],
    });

    render(<PluginConfigForm config={makeSecretConfig()} />);
    fireEvent.change(screen.getByLabelText('apiKey'), { target: { value: 'new-secret' } });
    fireEvent.click(screen.getByRole('button', { name: '変更を保存' }));
    await waitFor(() => expect(screen.getByText('連携中のユーザーがいます')).toBeInTheDocument());

    fireEvent.click(screen.getByRole('button', { name: '変更する' }));

    await waitFor(() => expect(screen.getByText('@crowi/plugin-synth-auth-test: 接続を確認しました')).toBeInTheDocument());
    expect(screen.getByText('この結果は、このリクエストを処理したインスタンスでの検証結果です。他のインスタンスでの結果は含みません。')).toBeInTheDocument();
  });

  it('renders the notice for a saved NON-secret field even though the `config` prop never refetches (dirty is checked against the save baseline, not a stale config-derived initialState)', async () => {
    mutateAsync.mockResolvedValueOnce({
      ok: true,
      hotReloaded: true,
      reconfigureFailed: false,
      verificationResults: [{ plugin: '@crowi/plugin-synth-auth-test', status: 'ok' }],
    });

    // `makeConfig()` is never re-rendered with fresh server data here — this
    // test's whole point is that the notice must not depend on that.
    render(<PluginConfigForm config={makeConfig()} />);
    fireEvent.change(screen.getByLabelText('clientId'), { target: { value: 'new-id' } });
    fireEvent.click(screen.getByRole('button', { name: '変更を保存' }));

    await waitFor(() => expect(screen.getByText('@crowi/plugin-synth-auth-test: 接続を確認しました')).toBeInTheDocument());
    // The save button reads `dirty` too — also proves the baseline moved.
    expect(screen.getByRole('button', { name: '変更を保存' })).toBeDisabled();
  });
});
