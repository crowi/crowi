import type { UserProfileResponse } from '@crowi/api-contract';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// `useUpdateProfile` wraps `useMutation`; only the server-rejection test
// below drives it, so a plain stub is enough. Paraglide messages are the
// real compiled output (aliased in vitest.config.ts), so assertions match
// the rendered copy — same convention as `linked-accounts-section.test.tsx`.
const { mutateAsync } = vi.hoisted(() => ({ mutateAsync: vi.fn() }));
vi.mock('@/lib/use-profile', () => ({
  useUpdateProfile: () => ({ mutateAsync, isPending: false }),
}));

import { ProfileForm } from './profile-form';

function makeProfile(federated: boolean): UserProfileResponse {
  return {
    id: 'u1',
    username: 'dave',
    name: 'Dave',
    email: 'dave@example.com',
    lang: 'en',
    theme: 'system',
    image: null,
    hasPassword: true,
    createdAt: '2026-01-01T00:00:00.000Z',
    federated,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(cleanup);

describe('ProfileForm — federated email lock (AC-6)', () => {
  it('leaves the email input enabled with no lock hint for a non-federated profile', () => {
    render(<ProfileForm profile={makeProfile(false)} />);

    expect(screen.getByLabelText('メールアドレス')).not.toBeDisabled();
    expect(screen.queryByText('外部サービスと連携しているため、メールアドレスを変更できません。')).not.toBeInTheDocument();
  });

  it('disables the email input and shows the lock hint for a federated profile', () => {
    render(<ProfileForm profile={makeProfile(true)} />);

    expect(screen.getByLabelText('メールアドレス')).toBeDisabled();
    expect(screen.getByText('外部サービスと連携しているため、メールアドレスを変更できません。')).toBeInTheDocument();
  });

  // The `disabled` above is an explanation, not the defence: the api refuses
  // the change even when the field was never disabled (a stale profile in
  // cache, a client that ignores the flag, a direct call). Render the
  // NON-federated profile so the only place this string can come from is the
  // error alert — the federated render shows the same copy as a static hint.
  it('shows the localized lock message when the server refuses with EMAIL_LOCKED_BY_FEDERATED_IDENTITY', async () => {
    mutateAsync.mockRejectedValue(
      Object.assign(new Error('Email address is managed by a linked external account'), { code: 'EMAIL_LOCKED_BY_FEDERATED_IDENTITY' }),
    );
    render(<ProfileForm profile={makeProfile(false)} />);

    // Save is `disabled={!hasChanges}` — dirty the form first.
    fireEvent.change(screen.getByLabelText('名前'), { target: { name: 'name', value: 'Dave Renamed' } });
    fireEvent.click(screen.getByRole('button', { name: '変更を保存' }));

    expect(await screen.findByText('外部サービスと連携しているため、メールアドレスを変更できません。')).toBeInTheDocument();
  });
});
