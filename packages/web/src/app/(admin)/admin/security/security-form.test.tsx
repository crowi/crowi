import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SecuritySettings, UpdateSecuritySettingsRequest } from '@crowi/api-contract';

/**
 * `SecurityForm` mounts `useUpdateAdminSecuritySettings()` (a react-query
 * mutation hook), so this mocks `@/lib/use-admin-security` the same way
 * `renderer-stylesheets.test.tsx` mocks `@/lib/use-app-info` — keeps this an
 * isolated component test with no `QueryClientProvider` needed.
 *
 * feature-renderer-plugin-boundary Phase 3 — no test file existed for this
 * component before this phase. Focus here is the new `linkCardEnabled`
 * Switch: checked/onCheckedChange wiring, isDirty / PUT-payload inclusion,
 * label/help text. The pre-existing registrationMode/registrationWhiteList
 * fields are exercised only incidentally (never interacted with directly —
 * the `registrationMode` field is a Radix `Select`, which needs jsdom
 * pointer-capture polyfills this file doesn't set up).
 */
const { mutateAsync, isPendingRef } = vi.hoisted(() => ({
  mutateAsync: vi.fn(),
  isPendingRef: { value: false },
}));
vi.mock('@/lib/use-admin-security', () => ({
  useUpdateAdminSecuritySettings: () => ({ mutateAsync, isPending: isPendingRef.value }),
}));

import { m } from '@paraglide/messages.js';
import { SecurityForm } from './security-form';

const BASE_SETTINGS: SecuritySettings = {
  registrationMode: 'Open',
  registrationWhiteList: [],
  linkCardEnabled: true,
};

afterEach(() => {
  cleanup();
  mutateAsync.mockReset();
  isPendingRef.value = false;
});

describe('SecurityForm — linkCardEnabled Switch', () => {
  it('renders the section heading/help copy', () => {
    render(<SecurityForm settings={BASE_SETTINGS} />);
    expect(screen.getByText(m['admin.security.section_link_card_heading']())).toBeTruthy();
    expect(screen.getByText(m['admin.security.field_link_card_label']())).toBeTruthy();
    expect(screen.getByText(m['admin.security.field_link_card_help']())).toBeTruthy();
  });

  it('is checked when settings.linkCardEnabled is true', () => {
    render(<SecurityForm settings={BASE_SETTINGS} />);
    const toggle = screen.getByRole('switch');
    expect(toggle).toHaveAttribute('aria-checked', 'true');
  });

  it('is unchecked when settings.linkCardEnabled is false', () => {
    render(<SecurityForm settings={{ ...BASE_SETTINGS, linkCardEnabled: false }} />);
    const toggle = screen.getByRole('switch');
    expect(toggle).toHaveAttribute('aria-checked', 'false');
  });

  it('the submit button starts disabled (form not dirty)', () => {
    render(<SecurityForm settings={BASE_SETTINGS} />);
    expect(screen.getByRole('button', { name: m['admin.common.submit']() })).toBeDisabled();
  });

  it('clicking the switch alone flips aria-checked and marks the form dirty (enables Submit)', () => {
    render(<SecurityForm settings={BASE_SETTINGS} />);
    const toggle = screen.getByRole('switch');
    const submit = screen.getByRole('button', { name: m['admin.common.submit']() });

    fireEvent.click(toggle);

    expect(toggle).toHaveAttribute('aria-checked', 'false');
    expect(submit).not.toBeDisabled();
  });

  it('toggling back to the original value re-disables Submit (isDirty compares against the settings prop, not a dirty flag)', () => {
    render(<SecurityForm settings={BASE_SETTINGS} />);
    const toggle = screen.getByRole('switch');
    const submit = screen.getByRole('button', { name: m['admin.common.submit']() });

    fireEvent.click(toggle); // true -> false, dirty
    expect(submit).not.toBeDisabled();
    fireEvent.click(toggle); // false -> true, back to original
    expect(submit).toBeDisabled();
  });

  it('submitting a linkCardEnabled-only change includes it (unchanged) alongside the registration fields in the PUT payload', async () => {
    mutateAsync.mockResolvedValueOnce({ ...BASE_SETTINGS, linkCardEnabled: false });
    render(<SecurityForm settings={BASE_SETTINGS} />);

    fireEvent.click(screen.getByRole('switch'));
    fireEvent.click(screen.getByRole('button', { name: m['admin.common.submit']() }));

    await waitFor(() => expect(mutateAsync).toHaveBeenCalledTimes(1));
    const payload = mutateAsync.mock.calls[0][0] as UpdateSecuritySettingsRequest;
    expect(payload).toEqual({
      registrationMode: 'Open',
      registrationWhiteList: [],
      linkCardEnabled: false,
    });
  });

  it('a successful submit shows the saved confirmation and reflects the server-returned linkCardEnabled back into the switch state', async () => {
    mutateAsync.mockResolvedValueOnce({ ...BASE_SETTINGS, linkCardEnabled: false });
    render(<SecurityForm settings={BASE_SETTINGS} />);

    fireEvent.click(screen.getByRole('switch'));
    fireEvent.click(screen.getByRole('button', { name: m['admin.common.submit']() }));

    await waitFor(() => expect(screen.getByText(m['admin.security.success_saved']())).toBeTruthy());
    // `updated.linkCardEnabled` (the server echo) is what's reflected here —
    // `settings` itself is a static prop in this isolated test (a real page
    // re-renders it from the query cache the mutation's `onSuccess` seeds),
    // so `isDirty` against the ORIGINAL `settings` prop is a separate concern
    // this test does not assert on.
    expect(screen.getByRole('switch')).toHaveAttribute('aria-checked', 'false');
  });
});
