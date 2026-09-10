import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { GetArtifactSettingsResponse, UpdateArtifactSettingsRequest } from '@crowi/api-contract';

/**
 * `ArtifactForm` mounts `useUpdateAdminArtifactSettings()` (a react-query
 * mutation hook), so this mocks `@/lib/use-admin-artifact` the same way
 * `security-form.test.tsx` mocks `@/lib/use-admin-security` — an isolated
 * component test with no `QueryClientProvider` needed.
 */
const { mutateAsync, isPendingRef } = vi.hoisted(() => ({
  mutateAsync: vi.fn(),
  isPendingRef: { value: false },
}));
vi.mock('@/lib/use-admin-artifact', () => ({
  useUpdateAdminArtifactSettings: () => ({ mutateAsync, isPending: isPendingRef.value }),
}));

import { m } from '@paraglide/messages.js';
import { ArtifactForm } from './artifact-form';

const BASE_SETTINGS: GetArtifactSettingsResponse = {
  deliveryMode: 'disabled',
  artifactOrigin: null,
  crowiOrigin: 'https://wiki.example.com',
  writeEnabled: false,
  sameOriginInactiveReason: null,
  settings: { sameOriginEnabled: false, allowWebFonts: false, maxBytes: 2 * 1024 * 1024 },
};

afterEach(() => {
  cleanup();
  mutateAsync.mockReset();
  isPendingRef.value = false;
});

describe('ArtifactForm', () => {
  it('always renders the 4 same-origin risk/precondition lines, regardless of the toggle state', () => {
    render(<ArtifactForm settings={BASE_SETTINGS} />);
    expect(screen.getByText(m['admin.artifact.same_origin_risk_cookies']())).toBeTruthy();
    expect(screen.getByText(m['admin.artifact.same_origin_risk_proxy']())).toBeTruthy();
    expect(screen.getByText(m['admin.artifact.same_origin_recommend_separate_origin']())).toBeTruthy();
    expect(screen.getByText(m['admin.artifact.same_origin_precondition_topology']())).toBeTruthy();
  });

  it('still renders all 4 lines after the same-origin Switch is toggled on', () => {
    render(<ArtifactForm settings={BASE_SETTINGS} />);
    const switches = screen.getAllByRole('switch');
    fireEvent.click(switches[0]);
    expect(screen.getByText(m['admin.artifact.same_origin_risk_cookies']())).toBeTruthy();
    expect(screen.getByText(m['admin.artifact.same_origin_risk_proxy']())).toBeTruthy();
    expect(screen.getByText(m['admin.artifact.same_origin_recommend_separate_origin']())).toBeTruthy();
    expect(screen.getByText(m['admin.artifact.same_origin_precondition_topology']())).toBeTruthy();
  });

  it('renders the status card mode / writeEnabled / origins', () => {
    render(
      <ArtifactForm
        settings={{
          deliveryMode: 'separate-origin',
          artifactOrigin: 'https://artifacts.example.net',
          crowiOrigin: 'https://wiki.example.com',
          writeEnabled: true,
          sameOriginInactiveReason: null,
          settings: { sameOriginEnabled: false, allowWebFonts: false, maxBytes: 2 * 1024 * 1024 },
        }}
      />,
    );
    expect(screen.getByText(m['admin.artifact.status_mode_separate_origin']())).toBeTruthy();
    expect(screen.getByText(m['admin.artifact.status_write_enabled_yes']())).toBeTruthy();
    expect(screen.getByText('https://artifacts.example.net')).toBeTruthy();
    expect(screen.getByText('https://wiki.example.com')).toBeTruthy();
  });

  it("shows the 'separate-origin-active' inactive reason", () => {
    render(
      <ArtifactForm
        settings={{
          ...BASE_SETTINGS,
          deliveryMode: 'separate-origin',
          artifactOrigin: 'https://artifacts.example.net',
          writeEnabled: true,
          sameOriginInactiveReason: 'separate-origin-active',
          settings: { sameOriginEnabled: true, allowWebFonts: false, maxBytes: 2 * 1024 * 1024 },
        }}
      />,
    );
    expect(screen.getByText(m['admin.artifact.status_same_origin_inactive_separate_origin_active']())).toBeTruthy();
  });

  it("shows the 'client-url-unset' inactive reason", () => {
    render(
      <ArtifactForm
        settings={{
          ...BASE_SETTINGS,
          sameOriginInactiveReason: 'client-url-unset',
          settings: { sameOriginEnabled: true, allowWebFonts: false, maxBytes: 2 * 1024 * 1024 },
        }}
      />,
    );
    expect(screen.getByText(m['admin.artifact.status_same_origin_inactive_client_url_unset']())).toBeTruthy();
  });

  it('shows the disabled hint when deliveryMode is disabled', () => {
    render(<ArtifactForm settings={BASE_SETTINGS} />);
    expect(screen.getByText(m['admin.artifact.status_disabled_hint']())).toBeTruthy();
  });

  it('the submit button starts disabled (form not dirty)', () => {
    render(<ArtifactForm settings={BASE_SETTINGS} />);
    expect(screen.getByRole('button', { name: m['admin.common.submit']() })).toBeDisabled();
  });

  it('toggling the same-origin Switch marks the form dirty (enables Submit)', () => {
    render(<ArtifactForm settings={BASE_SETTINGS} />);
    const switches = screen.getAllByRole('switch');
    const submit = screen.getByRole('button', { name: m['admin.common.submit']() });

    fireEvent.click(switches[0]);
    expect(submit).not.toBeDisabled();
  });

  it('toggling back to the original value re-disables Submit', () => {
    render(<ArtifactForm settings={BASE_SETTINGS} />);
    const switches = screen.getAllByRole('switch');
    const submit = screen.getByRole('button', { name: m['admin.common.submit']() });

    fireEvent.click(switches[0]);
    expect(submit).not.toBeDisabled();
    fireEvent.click(switches[0]);
    expect(submit).toBeDisabled();
  });

  it('changing the maxBytes input marks the form dirty', () => {
    render(<ArtifactForm settings={BASE_SETTINGS} />);
    const input = screen.getByLabelText(m['admin.artifact.field_max_bytes_label']()) as HTMLInputElement;
    fireEvent.change(input, { target: { value: String(5 * 1024 * 1024) } });
    expect(screen.getByRole('button', { name: m['admin.common.submit']() })).not.toBeDisabled();
  });

  it('shows the range error and disables Submit when maxBytes is below the minimum', () => {
    render(<ArtifactForm settings={BASE_SETTINGS} />);
    const input = screen.getByLabelText(m['admin.artifact.field_max_bytes_label']());
    fireEvent.change(input, { target: { value: '0' } });

    expect(screen.getByText(m['admin.artifact.error_max_bytes_range']())).toBeTruthy();
    expect(screen.getByRole('button', { name: m['admin.common.submit']() })).toBeDisabled();
  });

  it('shows the range error and disables Submit when maxBytes is above the maximum', () => {
    render(<ArtifactForm settings={BASE_SETTINGS} />);
    const input = screen.getByLabelText(m['admin.artifact.field_max_bytes_label']());
    fireEvent.change(input, { target: { value: String(11 * 1024 * 1024) } });

    expect(screen.getByText(m['admin.artifact.error_max_bytes_range']())).toBeTruthy();
    expect(screen.getByRole('button', { name: m['admin.common.submit']() })).toBeDisabled();
  });

  it('re-enables Submit once maxBytes is back in range', () => {
    render(<ArtifactForm settings={BASE_SETTINGS} />);
    const input = screen.getByLabelText(m['admin.artifact.field_max_bytes_label']());

    fireEvent.change(input, { target: { value: '0' } });
    expect(screen.getByRole('button', { name: m['admin.common.submit']() })).toBeDisabled();

    fireEvent.change(input, { target: { value: String(5 * 1024 * 1024) } });
    expect(screen.queryByText(m['admin.artifact.error_max_bytes_range']())).toBeNull();
    expect(screen.getByRole('button', { name: m['admin.common.submit']() })).not.toBeDisabled();
  });

  it('submits a payload with exactly the 3 keys', async () => {
    mutateAsync.mockResolvedValueOnce({ ...BASE_SETTINGS, settings: { sameOriginEnabled: true, allowWebFonts: false, maxBytes: 2 * 1024 * 1024 } });
    render(<ArtifactForm settings={BASE_SETTINGS} />);

    fireEvent.click(screen.getAllByRole('switch')[0]);
    fireEvent.click(screen.getByRole('button', { name: m['admin.common.submit']() }));

    await waitFor(() => expect(mutateAsync).toHaveBeenCalledTimes(1));
    const payload = mutateAsync.mock.calls[0][0] as UpdateArtifactSettingsRequest;
    expect(Object.keys(payload).sort()).toEqual(['allowWebFonts', 'maxBytes', 'sameOriginEnabled']);
    expect(payload).toEqual({ sameOriginEnabled: true, allowWebFonts: false, maxBytes: 2 * 1024 * 1024 });
  });

  it('a successful submit shows the saved confirmation', async () => {
    mutateAsync.mockResolvedValueOnce({ ...BASE_SETTINGS, settings: { sameOriginEnabled: true, allowWebFonts: false, maxBytes: 2 * 1024 * 1024 } });
    render(<ArtifactForm settings={BASE_SETTINGS} />);

    fireEvent.click(screen.getAllByRole('switch')[0]);
    fireEvent.click(screen.getByRole('button', { name: m['admin.common.submit']() }));

    await waitFor(() => expect(screen.getByText(m['admin.artifact.success_saved']())).toBeTruthy());
  });

  it('a rejected submit shows the thrown error message', async () => {
    mutateAsync.mockRejectedValueOnce(new Error(m['admin.artifact.error_same_origin_requires_client_url']()));
    render(<ArtifactForm settings={BASE_SETTINGS} />);

    fireEvent.click(screen.getAllByRole('switch')[0]);
    fireEvent.click(screen.getByRole('button', { name: m['admin.common.submit']() }));

    await waitFor(() => expect(screen.getByText(m['admin.artifact.error_same_origin_requires_client_url']())).toBeTruthy());
  });
});
