import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { m } from '@paraglide/messages.js';
import { overwriteGetLocale } from '@paraglide/runtime.js';

// Mock the mail settings hooks so this is a pure UI test — no react-query,
// no API (matches plugin-readiness-banner.test.tsx's pattern) — but keep the
// REAL `MailSettingsValidationFailure` / `MailTestFailure` classes so the
// component's own `instanceof` checks still behave correctly.
const { useMailSettings, useUpdateMailSettings, useSendTestMail } = vi.hoisted(() => ({
  useMailSettings: vi.fn(),
  useUpdateMailSettings: vi.fn(),
  useSendTestMail: vi.fn(),
}));
vi.mock('@/lib/use-admin-mail-settings', async () => {
  const actual = await vi.importActual<typeof import('@/lib/use-admin-mail-settings')>('@/lib/use-admin-mail-settings');
  return { ...actual, useMailSettings, useUpdateMailSettings, useSendTestMail };
});

const { useAuth } = vi.hoisted(() => ({ useAuth: vi.fn() }));
vi.mock('@/lib/use-auth', () => ({ useAuth }));

vi.mock('next/link', () => ({
  default: ({ href, children, ...rest }: { href: string; children: ReactNode }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));

import { MailTestFailure } from '@/lib/use-admin-mail-settings';
import { MailSettingsForm } from './mail-settings-form';

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  overwriteGetLocale(() => 'en');
});

function setup(overrides: { sendTestError?: unknown; sendTestIsError?: boolean } = {}) {
  useMailSettings.mockReturnValue({
    data: { from: 'noreply@example.com', activeDriver: 'smtp', activePlugin: '@crowi/plugin-mail-smtp' },
    isLoading: false,
    isError: false,
    refetch: vi.fn(),
  });
  useUpdateMailSettings.mockReturnValue({ mutateAsync: vi.fn(), isPending: false, isError: false, error: null });
  useSendTestMail.mockReturnValue({
    mutateAsync: vi.fn().mockRejectedValue(overrides.sendTestError ?? new Error('boom')),
    isPending: false,
    isError: overrides.sendTestIsError ?? false,
    error: overrides.sendTestError ?? null,
  });
  useAuth.mockReturnValue({ user: { email: 'admin@example.com' } });
}

describe('MailSettingsForm — test-send error display (feature-core-config-readiness-and-mail AC-5/AC-6)', () => {
  it.each([
    ['en', 'The sender address is not configured. Set it from mail settings.', 'Open mail settings'],
    ['ja', '送信元アドレスが未設定です。メール設定から設定してください。', 'メール設定を開く'],
  ] as const)('shows the %s localized "sender not configured" copy and a link to mail settings for MAIL_FROM_NOT_CONFIGURED', (locale, copy, linkText) => {
    overwriteGetLocale(() => locale);
    setup({ sendTestError: new MailTestFailure('MAIL_FROM_NOT_CONFIGURED'), sendTestIsError: true });

    render(<MailSettingsForm />);

    expect(screen.getByText(copy)).toBeTruthy();
    const link = screen.getByRole('link', { name: linkText });
    expect(link.getAttribute('href')).toBe('/admin/mail');
    // Never the raw config key or an internal identifier.
    expect(document.body.textContent).not.toContain('mail:from');
    expect(document.body.textContent).not.toContain('MAIL_FROM_NOT_CONFIGURED');
  });

  it('shows the generic localized failure and NO settings link for MAIL_TEST_FAILED, and never renders transport details', () => {
    setup({ sendTestError: new MailTestFailure('MAIL_TEST_FAILED'), sendTestIsError: true });

    render(<MailSettingsForm />);

    expect(screen.getByText(m['errors.mail_test_failed']())).toBeTruthy();
    expect(screen.queryByRole('link', { name: m['admin.mail.test_failed_from_link']() })).toBeNull();
    expect(document.body.textContent).not.toContain('ECONNREFUSED');
    expect(document.body.textContent).not.toContain('MAIL_TEST_FAILED');
  });

  it('renders nothing extra when there is no test-send error', () => {
    setup();
    render(<MailSettingsForm />);
    expect(screen.queryByRole('link', { name: m['admin.mail.test_failed_from_link']() })).toBeNull();
  });

  it('triggers a test send when the button is clicked and surfaces the resulting MailTestFailure', async () => {
    setup();
    const mutateAsync = vi.fn().mockRejectedValue(new MailTestFailure('MAIL_FROM_NOT_CONFIGURED'));
    useSendTestMail.mockReturnValue({ mutateAsync, isPending: false, isError: false, error: null });

    const { rerender } = render(<MailSettingsForm />);
    fireEvent.click(screen.getByText(m['admin.mail.test_button']()));

    await waitFor(() => expect(mutateAsync).toHaveBeenCalledTimes(1));

    // Simulate react-query re-rendering with the mutation's error state.
    useSendTestMail.mockReturnValue({
      mutateAsync,
      isPending: false,
      isError: true,
      error: new MailTestFailure('MAIL_FROM_NOT_CONFIGURED'),
    });
    rerender(<MailSettingsForm />);

    expect(screen.getByRole('link', { name: m['admin.mail.test_failed_from_link']() })).toBeTruthy();
  });
});
