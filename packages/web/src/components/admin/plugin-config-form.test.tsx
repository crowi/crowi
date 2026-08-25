import type { PluginConfigResponse } from '@crowi/api-contract';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Pure component test: `useUpdateAdminPluginConfig` is mocked (matches
// `mail-settings-form.test.tsx`'s pattern), but the REAL
// `LinkedIdentitiesExistError` / `PluginConfigValidationError` classes are
// kept via `importActual` so the component's own `instanceof` checks behave
// correctly.
const { useUpdateAdminPluginConfig, mutateAsync } = vi.hoisted(() => ({
  useUpdateAdminPluginConfig: vi.fn(),
  mutateAsync: vi.fn(),
}));
vi.mock('@/lib/use-admin-plugins', async () => {
  const actual = await vi.importActual<typeof import('@/lib/use-admin-plugins')>('@/lib/use-admin-plugins');
  return { ...actual, useUpdateAdminPluginConfig };
});

import { LinkedIdentitiesExistError } from '@/lib/use-admin-plugins';
import { PluginConfigForm } from './plugin-config-form';

function makeConfig(): PluginConfigResponse {
  return {
    name: '@crowi/plugin-synth-auth-test',
    fields: [{ name: 'clientId', kind: 'string', optional: false }],
    values: { clientId: 'old-id' },
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
