import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
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
  htmlSanitizationEnabled: true,
};

afterEach(() => {
  cleanup();
  mutateAsync.mockReset();
  isPendingRef.value = false;
});

const linkCardSwitch = () => screen.getByRole('switch', { name: m['admin.security.field_link_card_label']() });
const htmlSwitch = () => screen.getByRole('switch', { name: m['admin.security.field_html_sanitization_label']() });
const submitButton = () => screen.getByRole('button', { name: m['admin.common.submit']() });
const sentPayload = (call = 0) => mutateAsync.mock.calls[call][0] as UpdateSecuritySettingsRequest;

describe('SecurityForm — linkCardEnabled Switch', () => {
  it('renders the section heading/help copy', () => {
    render(<SecurityForm settings={BASE_SETTINGS} />);
    expect(screen.getByText(m['admin.security.section_link_card_heading']())).toBeTruthy();
    expect(screen.getByText(m['admin.security.field_link_card_label']())).toBeTruthy();
    expect(screen.getByText(m['admin.security.field_link_card_help']())).toBeTruthy();
  });

  it('reflects settings.linkCardEnabled', () => {
    render(<SecurityForm settings={BASE_SETTINGS} />);
    expect(linkCardSwitch()).toHaveAttribute('aria-checked', 'true');
    cleanup();
    render(<SecurityForm settings={{ ...BASE_SETTINGS, linkCardEnabled: false }} />);
    expect(linkCardSwitch()).toHaveAttribute('aria-checked', 'false');
  });

  it('the submit button starts disabled (form not dirty)', () => {
    render(<SecurityForm settings={BASE_SETTINGS} />);
    expect(submitButton()).toBeDisabled();
  });

  it('toggling away and back re-disables Submit (dirty is a comparison with the baseline)', () => {
    render(<SecurityForm settings={BASE_SETTINGS} />);
    fireEvent.click(linkCardSwitch());
    expect(submitButton()).not.toBeDisabled();
    fireEvent.click(linkCardSwitch());
    expect(submitButton()).toBeDisabled();
  });

  it('a link-card-only change sends only linkCardEnabled', async () => {
    mutateAsync.mockResolvedValueOnce({ ...BASE_SETTINGS, linkCardEnabled: false });
    render(<SecurityForm settings={BASE_SETTINGS} />);

    fireEvent.click(linkCardSwitch());
    fireEvent.click(submitButton());

    await waitFor(() => expect(mutateAsync).toHaveBeenCalledTimes(1));
    expect(sentPayload()).toEqual({ linkCardEnabled: false });
    expect(Object.keys(sentPayload())).toEqual(['linkCardEnabled']);
  });
});

describe('SecurityForm — htmlSanitizationEnabled Switch', () => {
  it('renders the heading, label and the standing explanation of the limits', () => {
    render(<SecurityForm settings={BASE_SETTINGS} />);
    expect(screen.getByText(m['admin.security.section_html_sanitization_heading']())).toBeTruthy();
    expect(screen.getByText(m['admin.security.html_sanitization_activation_help']())).toBeTruthy();
    expect(screen.getByText(m['admin.security.field_html_sanitization_help']()).textContent).toMatch(/iframe/i);
    expect(screen.getByText(m['admin.security.html_sanitization_caveats_heading']())).toBeTruthy();
    expect(screen.getByText(m['admin.security.html_sanitization_caveat_css_spoofing']()).textContent).toMatch(/CSS/);
    expect(screen.getByText(m['admin.security.html_sanitization_caveat_iframe']()).textContent).toMatch(/allow-scripts/);
  });

  it('defaults to ON, and treats a missing field from an older API as ON', () => {
    render(<SecurityForm settings={BASE_SETTINGS} />);
    expect(htmlSwitch()).toHaveAttribute('aria-checked', 'true');
    cleanup();
    const { htmlSanitizationEnabled: _omitted, ...legacy } = BASE_SETTINGS;
    render(<SecurityForm settings={legacy as SecuritySettings} />);
    expect(htmlSwitch()).toHaveAttribute('aria-checked', 'true');
    expect(submitButton()).toBeDisabled();
  });

  it('a toggle-only change sends only htmlSanitizationEnabled', async () => {
    mutateAsync.mockResolvedValueOnce({ ...BASE_SETTINGS, htmlSanitizationEnabled: false });
    render(<SecurityForm settings={BASE_SETTINGS} />);

    fireEvent.click(htmlSwitch());
    fireEvent.click(submitButton());

    await waitFor(() => expect(mutateAsync).toHaveBeenCalledTimes(1));
    expect(sentPayload()).toEqual({ htmlSanitizationEnabled: false });
    expect(Object.keys(sentPayload())).toEqual(['htmlSanitizationEnabled']);
  });

  it('a whitelist-only change sends only registrationWhiteList; a whitespace-only edit sends nothing', async () => {
    mutateAsync.mockResolvedValueOnce({ ...BASE_SETTINGS, registrationWhiteList: ['example.com'] });
    render(<SecurityForm settings={BASE_SETTINGS} />);
    const textarea = screen.getByRole('textbox');

    fireEvent.change(textarea, { target: { name: 'registrationWhiteListRaw', value: '  \n\n ' } });
    expect(submitButton()).toBeDisabled();

    fireEvent.change(textarea, { target: { name: 'registrationWhiteListRaw', value: ' example.com \r\n' } });
    fireEvent.click(submitButton());

    await waitFor(() => expect(mutateAsync).toHaveBeenCalledTimes(1));
    expect(sentPayload()).toEqual({ registrationWhiteList: ['example.com'] });
  });

  it('clearing the whitelist is sent explicitly as an empty array', async () => {
    mutateAsync.mockResolvedValueOnce({ ...BASE_SETTINGS, registrationWhiteList: [] });
    render(<SecurityForm settings={{ ...BASE_SETTINGS, registrationWhiteList: ['example.com'] }} />);

    fireEvent.change(screen.getByRole('textbox'), { target: { name: 'registrationWhiteListRaw', value: '' } });
    fireEvent.click(submitButton());

    await waitFor(() => expect(mutateAsync).toHaveBeenCalledTimes(1));
    expect(sentPayload()).toEqual({ registrationWhiteList: [] });
  });

  it('a success response becomes the next comparison source', async () => {
    mutateAsync.mockResolvedValueOnce({ ...BASE_SETTINGS, htmlSanitizationEnabled: false });
    render(<SecurityForm settings={BASE_SETTINGS} />);

    fireEvent.click(htmlSwitch());
    fireEvent.click(submitButton());
    await waitFor(() => expect(screen.getByText(m['admin.security.success_saved']())).toBeTruthy());
    expect(htmlSwitch()).toHaveAttribute('aria-checked', 'false');
    // Saved value is the new baseline: nothing left to send.
    expect(submitButton()).toBeDisabled();

    mutateAsync.mockResolvedValueOnce({ ...BASE_SETTINGS, htmlSanitizationEnabled: false, linkCardEnabled: false });
    fireEvent.click(linkCardSwitch());
    fireEvent.click(submitButton());
    await waitFor(() => expect(mutateAsync).toHaveBeenCalledTimes(2));
    expect(sentPayload(1)).toEqual({ linkCardEnabled: false });
  });

  it('disables every input and the submit while saving and does not resubmit', async () => {
    let resolve: (value: SecuritySettings) => void = () => {};
    mutateAsync.mockReturnValueOnce(new Promise<SecuritySettings>((r) => (resolve = r)));
    const { rerender } = render(<SecurityForm settings={BASE_SETTINGS} />);

    fireEvent.click(htmlSwitch());
    fireEvent.click(submitButton());
    isPendingRef.value = true;
    rerender(<SecurityForm settings={BASE_SETTINGS} />);

    expect(htmlSwitch()).toBeDisabled();
    expect(linkCardSwitch()).toBeDisabled();
    expect(screen.getByRole('textbox')).toBeDisabled();
    expect(screen.getByRole('combobox')).toBeDisabled();
    expect(screen.getByRole('button', { name: m['admin.common.submit_pending']() })).toBeDisabled();
    fireEvent.submit(screen.getByRole('button', { name: m['admin.common.submit_pending']() }).closest('form') as HTMLFormElement);
    expect(mutateAsync).toHaveBeenCalledTimes(1);

    await act(async () => {
      resolve({ ...BASE_SETTINGS, htmlSanitizationEnabled: false });
    });
    isPendingRef.value = false;
    rerender(<SecurityForm settings={BASE_SETTINGS} />);
    expect(htmlSwitch()).not.toBeDisabled();
    expect(screen.getByRole('textbox')).not.toBeDisabled();
  });

  it('keeps the input and baseline after a failure, shows the error only, and re-sends the same changes', async () => {
    mutateAsync.mockRejectedValueOnce(new Error('boom'));
    render(<SecurityForm settings={BASE_SETTINGS} />);

    fireEvent.click(htmlSwitch());
    fireEvent.click(submitButton());

    await waitFor(() => expect(screen.getByText('boom')).toBeTruthy());
    expect(screen.queryByText(m['admin.security.success_saved']())).toBeNull();
    expect(htmlSwitch()).toHaveAttribute('aria-checked', 'false');
    expect(submitButton()).not.toBeDisabled();

    mutateAsync.mockResolvedValueOnce({ ...BASE_SETTINGS, htmlSanitizationEnabled: false });
    fireEvent.click(submitButton());
    await waitFor(() => expect(mutateAsync).toHaveBeenCalledTimes(2));
    expect(sentPayload(1)).toEqual({ htmlSanitizationEnabled: false });
  });
});
