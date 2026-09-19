import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { RegistrationMode } from '@crowi/api-contract';
import { overwriteGetLocale } from '@paraglide/runtime.js';

// Mock the app settings hooks so this is a pure UI test — no react-query, no
// API (matches mail-settings-form.test.tsx's pattern) — but keep the real
// `AppSettingsValidationFailure` class so the component's own `instanceof`
// checks still behave correctly.
const { useAppSettings, useUpdateAppSettings } = vi.hoisted(() => ({
  useAppSettings: vi.fn(),
  useUpdateAppSettings: vi.fn(),
}));
vi.mock('@/lib/use-admin-app-settings', async () => {
  const actual = await vi.importActual<typeof import('@/lib/use-admin-app-settings')>('@/lib/use-admin-app-settings');
  return { ...actual, useAppSettings, useUpdateAppSettings };
});

import { AppSettingsForm } from './app-settings-form';

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  overwriteGetLocale(() => 'en');
});

function setup(registrationMode: RegistrationMode) {
  useAppSettings.mockReturnValue({
    data: {
      app: { title: 'My Wiki', confidential: '' },
      isUploadable: true,
      registrationMode,
      setupChecklistDismissed: false,
    },
    isLoading: false,
    isError: false,
    refetch: vi.fn(),
  });
  useUpdateAppSettings.mockReturnValue({ mutateAsync: vi.fn(), isPending: false, isError: false, error: null });
}

describe('AppSettingsForm — registration mode status card (feature-admin-app-registration-mode AC-5/AC-6)', () => {
  it.each([
    ['en', 'Closed' as const, 'Closed (invite only)'],
    ['ja', 'Closed' as const, 'Closed (招待のみ)'],
  ] as const)('renders the security page label for the Closed registration mode (%s)', (locale, mode, expected) => {
    overwriteGetLocale(() => locale);
    setup(mode);

    render(<AppSettingsForm />);

    expect(screen.getByText(expected)).toBeTruthy();
  });

  it.each([
    ['en', 'Restricted (admin approval required)', 'invitation only'],
    ['ja', 'Restricted (管理者の承認が必要)', '招待のみ'],
  ] as const)('describes Resricted as requiring admin approval, not invitation (%s)', (locale, expected, forbidden) => {
    overwriteGetLocale(() => locale);
    setup('Resricted');

    render(<AppSettingsForm />);

    expect(screen.getByText(expected)).toBeTruthy();
    expect(document.body.textContent).not.toContain(forbidden);
  });

  it('renders the Open label for the Open registration mode', () => {
    setup('Open');

    render(<AppSettingsForm />);

    expect(screen.getByText('Open (anyone can register)')).toBeTruthy();
  });
});
