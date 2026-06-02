import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act } from 'react';
import { render, cleanup, screen, waitFor, fireEvent } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

/**
 * Tests for the editor inline session-reauth flow:
 *
 *   - silent refresh → no modal (the `auth:session-expired` event is the
 *     ONLY trigger; a successful silent refresh never dispatches it)
 *   - failed refresh → exactly one modal, redirect suppressed
 *   - successful reauth → modal closes + token queries are invalidated
 *     (collab + presence reconnect) WITHOUT unmounting the editor child
 *   - multi-tab → a `storage` access-token write closes the modal +
 *     refetches tokens here
 *   - discard → wipes tokens + navigates to /login
 *
 * `loginWithPassword` and `auth-token` are mocked so the test never hits
 * the network and we can assert on the persistence side effects.
 */

// --- next/navigation -------------------------------------------------
const { push } = vi.hoisted(() => ({ push: vi.fn() }));
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push, replace: vi.fn(), back: vi.fn() }),
}));

// --- shared login + token helpers ------------------------------------
const { loginWithPassword, clearTokens } = vi.hoisted(() => ({
  loginWithPassword: vi.fn(),
  clearTokens: vi.fn(),
}));
vi.mock('@/lib/auth-login', () => ({ loginWithPassword }));
vi.mock('@/lib/auth-token', () => ({ clearTokens }));

import { m } from '@paraglide/messages.js';
import { SessionReauthProvider, useReauthSuppressed, isReauthSuppressed } from './session-reauth-context';
import { SessionReauthModal } from '@/components/editor/session-reauth-modal';

// A spy on the real QueryClient so we can assert the token queries get
// invalidated with `refetchType: 'active'` (the reconnect trigger).
let invalidateSpy: ReturnType<typeof vi.fn>;

function Harness({ email = 'editor@example.com' }: { email?: string | null }) {
  return (
    <SessionReauthProvider pageId="page-1" currentEmail={email}>
      {/* Sentinel standing in for the live editor (Y.Doc / CodeMirror).
          It must stay mounted across the whole reauth round-trip. */}
      <div data-testid="editor-sentinel">editor</div>
      <SuppressionProbe />
      <SessionReauthModal />
    </SessionReauthProvider>
  );
}

function SuppressionProbe() {
  const suppressed = useReauthSuppressed();
  return <div data-testid="suppressed">{String(suppressed)}</div>;
}

function renderHarness(props?: { email?: string | null }) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  invalidateSpy = vi.fn().mockResolvedValue(undefined);
  queryClient.invalidateQueries = invalidateSpy as unknown as typeof queryClient.invalidateQueries;
  return render(
    <QueryClientProvider client={queryClient}>
      <Harness {...props} />
    </QueryClientProvider>,
  );
}

function dispatchSessionExpired() {
  act(() => {
    window.dispatchEvent(new CustomEvent('auth:session-expired'));
  });
}

beforeEach(() => {
  push.mockReset();
  loginWithPassword.mockReset();
  clearTokens.mockReset();
});

afterEach(() => {
  cleanup();
});

describe('SessionReauthProvider + SessionReauthModal', () => {
  it('keeps the modal closed until a session-expired event (silent refresh path)', () => {
    renderHarness();
    // No event yet → no modal. A silent refresh succeeds without ever
    // dispatching `auth:session-expired`, so this models the silent path.
    expect(screen.queryByText(m['edit.reauth_title']())).toBeNull();
    expect(screen.getByTestId('editor-sentinel')).toBeDefined();
  });

  it('suppresses the layout redirect as soon as the provider mounts (before any expiry)', () => {
    renderHarness();
    // The module-level signal is raised on mount so the (auth) layout —
    // an ancestor whose event listener runs first — defers to the modal.
    expect(isReauthSuppressed()).toBe(true);
    expect(screen.getByTestId('suppressed').textContent).toBe('true');
  });

  it('opens exactly one modal on a failed-refresh event and keeps the editor mounted', () => {
    renderHarness();
    dispatchSessionExpired();
    // A second event (e.g. presence + collab 401 both surfacing) must
    // not stack a second modal — single boolean state.
    dispatchSessionExpired();

    expect(screen.getAllByText(m['edit.reauth_title']())).toHaveLength(1);
    // The editor child is never unmounted → Y.Doc / buffer preserved.
    expect(screen.getByTestId('editor-sentinel')).toBeDefined();
  });

  it('pre-fills the email captured before clearTokens dropped the user', () => {
    renderHarness({ email: 'editor@example.com' });
    dispatchSessionExpired();
    const emailInput = screen.getByLabelText(m['edit.reauth_email_label']()) as HTMLInputElement;
    expect(emailInput.value).toBe('editor@example.com');
  });

  it('on successful reauth closes the modal and invalidates collab + presence token queries', async () => {
    loginWithPassword.mockResolvedValue({ ok: true });
    renderHarness();
    dispatchSessionExpired();

    fireEvent.change(screen.getByLabelText(m['edit.reauth_password_label']()), { target: { value: 'pw' } });
    fireEvent.click(screen.getByRole('button', { name: m['edit.reauth_submit']() }));

    await waitFor(() => expect(screen.queryByText(m['edit.reauth_title']())).toBeNull());
    // Both token queries refetched with refetchType:'active' so the
    // collab provider rebuilds and presence reconnects.
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['yjsToken', 'page-1'], refetchType: 'active' });
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['presenceToken', 'page-1'], refetchType: 'active' });
    // The editor was never torn down.
    expect(screen.getByTestId('editor-sentinel')).toBeDefined();
  });

  it('surfaces the error and keeps the modal open when reauth fails', async () => {
    loginWithPassword.mockResolvedValue({ ok: false, message: 'bad password' });
    renderHarness();
    dispatchSessionExpired();

    fireEvent.change(screen.getByLabelText(m['edit.reauth_password_label']()), { target: { value: 'wrong' } });
    fireEvent.click(screen.getByRole('button', { name: m['edit.reauth_submit']() }));

    await waitFor(() => expect(screen.getByText('bad password')).toBeDefined());
    expect(screen.getByText(m['edit.reauth_title']())).toBeDefined();
    expect(invalidateSpy).not.toHaveBeenCalled();
  });

  it('multi-tab: a storage access-token write closes the modal and refetches tokens', async () => {
    renderHarness();
    dispatchSessionExpired();
    expect(screen.getByText(m['edit.reauth_title']())).toBeDefined();

    // Another tab logged in → localStorage write → `storage` event here.
    act(() => {
      window.dispatchEvent(new StorageEvent('storage', { key: 'accessToken', newValue: 'fresh-token' }));
    });

    await waitFor(() => expect(screen.queryByText(m['edit.reauth_title']())).toBeNull());
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['yjsToken', 'page-1'], refetchType: 'active' });
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['presenceToken', 'page-1'], refetchType: 'active' });
    // No re-login was performed in this tab.
    expect(loginWithPassword).not.toHaveBeenCalled();
  });

  it('ignores a storage token *removal* (a logout elsewhere must not revive the editor)', () => {
    renderHarness();
    dispatchSessionExpired();
    act(() => {
      window.dispatchEvent(new StorageEvent('storage', { key: 'accessToken', newValue: null }));
    });
    // Modal stays open — a null write is a logout, not a recovery.
    expect(screen.getByText(m['edit.reauth_title']())).toBeDefined();
    expect(invalidateSpy).not.toHaveBeenCalled();
  });

  it('discard wipes tokens and navigates to the login screen', () => {
    renderHarness();
    dispatchSessionExpired();

    fireEvent.click(screen.getByRole('button', { name: m['edit.reauth_discard']() }));

    expect(clearTokens).toHaveBeenCalledTimes(1);
    expect(push).toHaveBeenCalledTimes(1);
    expect(String(push.mock.calls[0][0])).toContain('/login');
  });
});
