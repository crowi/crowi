import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * RFC-0014 phase 2 — AC-2 requires the registration screen to ALWAYS show a
 * REAL logout exit, including the OUTER Suspense `fallback` in `page.tsx`
 * (a skeleton React can show before `FederatedRegisterForm`, a client
 * component reading `useSearchParams()`, has hydrated). This must actually
 * invalidate the pending grant and clear local tokens — not just be a
 * plain, inert `<Link>` — because a stale tab or a shared link showing this
 * exact fallback state must not be a dead end that leaves an abandoned
 * grant live. That inner component's own loading/error/approval views are
 * covered by `federated-register-form.test.tsx`; this file covers the one
 * further sub-view those tests cannot reach.
 */
const { apiLogoutPost, clearTokensMock } = vi.hoisted(() => ({
  apiLogoutPost: vi.fn(),
  clearTokensMock: vi.fn(),
}));

vi.mock('@/lib/api-client', () => ({
  apiClient: {
    auth: {
      'federated-registration': {
        ':token': {
          logout: { $post: apiLogoutPost },
        },
      },
    },
  },
}));

vi.mock('@/lib/auth-token', () => ({
  clearTokens: clearTokensMock,
}));

import { FederatedRegisterFormFallback } from './federated-register-form-fallback';

// `window.location.href = ...` is how this component navigates (jsdom does
// not implement real navigation — assigning `href` is a silent no-op — so
// assertions on the target replace `window.location` with a minimal mock
// that records assignments, same convention as
// `app/(auth)/oauth/authorize/page.test.tsx`). `Object.defineProperty`
// (rather than a direct `window.location = ...` assignment) sidesteps
// TypeScript checking the mock object against `Location | string` (the
// setter's declared type — `window.location = "url"` is valid navigation
// shorthand), which would otherwise spuriously match the object literal
// against `String.prototype.search`'s method signature.
const originalLocation = window.location;
let hrefAssignments: string[];
let currentSearch: string;

beforeEach(() => {
  apiLogoutPost.mockReset();
  clearTokensMock.mockReset();
  hrefAssignments = [];
  currentSearch = '';
  const locationMock = {
    get search() {
      return currentSearch;
    },
    get href() {
      return originalLocation.href;
    },
    set href(value: string) {
      hrefAssignments.push(value);
    },
  } as unknown as Location;
  Object.defineProperty(window, 'location', { configurable: true, value: locationMock });
});

afterEach(() => {
  cleanup();
  Object.defineProperty(window, 'location', { configurable: true, value: originalLocation });
});

describe('FederatedRegisterFormFallback (AC-2)', () => {
  it('the link is a PERMANENT, inert `#` — both in its initial server-rendered markup and once mounted — never a real /login destination reachable by native browser navigation before hydration has attached the real click handler', () => {
    const ssrHtml = renderToStaticMarkup(<FederatedRegisterFormFallback />);
    expect(ssrHtml).not.toContain('href="/login"');
    // Still a real, visually-present link — just not pointed at a real
    // destination (`#`, same-page, harmless) that a pre-hydration native
    // click could silently follow, skipping cancellation entirely.
    expect(ssrHtml).toContain('サインインをやめる');

    render(<FederatedRegisterFormFallback />);
    const link = screen.getByRole('link', { name: 'サインインをやめる' });
    expect(link).toBeInTheDocument();
    expect(link).toHaveAttribute('href', '#');
  });

  it('clicking it cancels the pending grant (read from the URL, best-effort) and clears local tokens before leaving', async () => {
    currentSearch = '?token=grant-abc';
    apiLogoutPost.mockResolvedValue({ status: 204 });

    render(<FederatedRegisterFormFallback />);
    fireEvent.click(screen.getByRole('link', { name: 'サインインをやめる' }));

    await waitFor(() => expect(clearTokensMock).toHaveBeenCalledTimes(1));
    expect(apiLogoutPost).toHaveBeenCalledWith({ param: { token: 'grant-abc' } });
    expect(hrefAssignments).toEqual(['/login']);
  });

  it('still clears tokens and leaves even when the logout API call fails (best-effort) or there is no token at all', async () => {
    currentSearch = '';
    apiLogoutPost.mockRejectedValue(new Error('network error'));

    render(<FederatedRegisterFormFallback />);
    fireEvent.click(screen.getByRole('link', { name: 'サインインをやめる' }));

    await waitFor(() => expect(clearTokensMock).toHaveBeenCalledTimes(1));
    expect(apiLogoutPost).not.toHaveBeenCalled();
    expect(hrefAssignments).toEqual(['/login']);
  });
});
