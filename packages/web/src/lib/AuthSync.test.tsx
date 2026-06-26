import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, useEffect } from 'react';
import { render, cleanup } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createElement } from 'react';

/**
 * Tests for the centralized auth-listener island.
 *
 *   - auth:session-expired → queryClient.clear() (AC6); suppressed → no clear
 *   - cross-tab logout (storage newValue==null) → clear() + /login (AC10);
 *     suppressed → dispatch auth:session-expired (in-place recovery, AC19)
 *   - cross-tab account switch (oldValue!=newValue, both non-null) →
 *     removeQueries(non-auth) + resetQueries(auth), NOT clear() (AC20)
 *   - silent token refresh → invalidateQueries(auth, active) (AC11)
 *   - retry button → refetchQueries(auth) via single registerRetryCallback (AC9)
 */

// --- next/navigation -------------------------------------------------
const { push } = vi.hoisted(() => ({ push: vi.fn() }));
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push, replace: vi.fn(), back: vi.fn() }),
}));

// --- inline-reauth suppression (module-level signal) -----------------
const { suppressed } = vi.hoisted(() => ({ suppressed: { value: false } }));
vi.mock('./session-reauth-context', () => ({ isReauthSuppressed: () => suppressed.value }));

import { ConnectionProvider, useConnection } from './connection-context';
import { notifyTokenRefreshed } from './token-refresh-notifier';
import { AuthSync } from './AuthSync';
import { authKeys } from './use-auth';

let capturedRetry: (() => void) | null = null;
function RetryProbe() {
  const { retry } = useConnection();
  // Capture in an effect (not during render) so the connection retry — wired
  // by AuthSync's single registerRetryCallback — can be triggered from a test.
  useEffect(() => {
    capturedRetry = retry;
  }, [retry]);
  return null;
}

function makeClient(): QueryClient {
  return new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 60_000 } } });
}

function renderSync(client: QueryClient) {
  return render(createElement(QueryClientProvider, { client }, createElement(ConnectionProvider, null, createElement(AuthSync), createElement(RetryProbe))));
}

function dispatchStorage(oldValue: string | null, newValue: string | null) {
  act(() => {
    window.dispatchEvent(new StorageEvent('storage', { key: 'accessToken', oldValue, newValue }));
  });
}

function dispatchSessionExpired() {
  act(() => {
    window.dispatchEvent(new CustomEvent('auth:session-expired'));
  });
}

beforeEach(() => {
  push.mockReset();
  suppressed.value = false;
  capturedRetry = null;
});

afterEach(() => {
  cleanup();
});

describe('AuthSync', () => {
  it('clears the whole cache on auth:session-expired (not suppressed)', () => {
    const client = makeClient();
    const clearSpy = vi.spyOn(client, 'clear');
    renderSync(client);

    dispatchSessionExpired();

    expect(clearSpy).toHaveBeenCalledTimes(1);
  });

  it('does NOT clear on auth:session-expired while inline-reauth is suppressed', () => {
    suppressed.value = true;
    const client = makeClient();
    const clearSpy = vi.spyOn(client, 'clear');
    renderSync(client);

    dispatchSessionExpired();

    expect(clearSpy).not.toHaveBeenCalled();
  });

  it('clears cache and redirects to /login on cross-tab logout (not suppressed)', () => {
    const client = makeClient();
    const clearSpy = vi.spyOn(client, 'clear');
    renderSync(client);

    dispatchStorage('old-tok', null);

    expect(clearSpy).toHaveBeenCalledTimes(1);
    expect(push).toHaveBeenCalledWith('/login');
  });

  it('opens the inline modal (no clear/redirect) on cross-tab logout while suppressed', () => {
    suppressed.value = true;
    const client = makeClient();
    const clearSpy = vi.spyOn(client, 'clear');
    renderSync(client);

    let inlineFired = false;
    const onExpired = () => {
      inlineFired = true;
    };
    window.addEventListener('auth:session-expired', onExpired);
    dispatchStorage('old-tok', null);
    window.removeEventListener('auth:session-expired', onExpired);

    expect(inlineFired).toBe(true); // in-place recovery dispatched
    expect(clearSpy).not.toHaveBeenCalled();
    expect(push).not.toHaveBeenCalled();
  });

  it('removes non-auth cache and resets the auth query on cross-tab account switch', () => {
    const client = makeClient();
    const clearSpy = vi.spyOn(client, 'clear');
    const removeSpy = vi.spyOn(client, 'removeQueries');
    const resetSpy = vi.spyOn(client, 'resetQueries');
    renderSync(client);

    dispatchStorage('user-a-tok', 'user-b-tok');

    expect(clearSpy).not.toHaveBeenCalled(); // clear()+refetch is a v5 no-op
    expect(removeSpy).toHaveBeenCalledTimes(1);
    expect(resetSpy).toHaveBeenCalledWith({ queryKey: authKeys.me() });
    expect(push).not.toHaveBeenCalled();
  });

  it('ignores cross-tab login (oldValue null) — leaves recovery to the reactive store', () => {
    const client = makeClient();
    const clearSpy = vi.spyOn(client, 'clear');
    const removeSpy = vi.spyOn(client, 'removeQueries');
    const resetSpy = vi.spyOn(client, 'resetQueries');
    renderSync(client);

    dispatchStorage(null, 'fresh-tok');

    expect(clearSpy).not.toHaveBeenCalled();
    expect(removeSpy).not.toHaveBeenCalled();
    expect(resetSpy).not.toHaveBeenCalled();
    expect(push).not.toHaveBeenCalled();
  });

  it('invalidates the active auth query after a silent token refresh', () => {
    const client = makeClient();
    const invalidateSpy = vi.spyOn(client, 'invalidateQueries');
    renderSync(client);

    act(() => {
      notifyTokenRefreshed();
    });

    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: authKeys.me(), refetchType: 'active' });
  });

  it('refetches the auth query via the single registered retry callback', () => {
    const client = makeClient();
    const refetchSpy = vi.spyOn(client, 'refetchQueries');
    renderSync(client);

    act(() => {
      capturedRetry?.();
    });

    expect(refetchSpy).toHaveBeenCalledWith({ queryKey: authKeys.me() });
  });
});
