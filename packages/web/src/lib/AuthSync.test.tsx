import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render } from '@testing-library/react';
import { act, createElement, useEffect } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Tests for the centralized auth-listener island.
 *
 *   - auth:session-expired → queryClient.clear() (AC6); suppressed → no clear
 *   - cross-tab logout (storage newValue==null) → clear() (AC10); the /login
 *     redirect is the layout's job (driven by the reactive store), not AuthSync;
 *     suppressed → dispatch auth:session-expired (in-place recovery, AC19)
 *   - cross-tab account switch — DIFFERENT user (userId claim differs) →
 *     removeQueries(non-auth) + resetQueries(auth), NOT clear() (AC20)
 *   - cross-tab same-user silent refresh (userId equal, token string differs) →
 *     no-op (must not wipe the cache on every token rotation)
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

import { AuthSync } from './AuthSync';
import { ConnectionProvider, useConnection } from './connection-context';
import { notifyTokenRefreshed } from './token-refresh-notifier';
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

// Mint a fake access-token JWT (header.payload.sig) carrying a `userId` claim,
// matching the api's access-token shape (util/jwt.ts). `iat` varies the string
// so a same-user refresh produces a DIFFERENT token with the SAME userId.
function mkAccessToken(userId: string, iat = 1): string {
  const b64url = (o: unknown) => btoa(JSON.stringify(o)).replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
  return `${b64url({ alg: 'HS256', typ: 'JWT' })}.${b64url({ userId, type: 'access', iat })}.sig`;
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

  it('clears the whole cache on cross-tab logout; the redirect is the layout’s job', () => {
    const client = makeClient();
    const clearSpy = vi.spyOn(client, 'clear');
    renderSync(client);

    dispatchStorage('old-tok', null);

    expect(clearSpy).toHaveBeenCalledTimes(1);
    // AuthSync no longer pushes /login itself — the reactive store flips
    // hasToken→false and the (auth)/(admin) layout owns the (param-bearing)
    // redirect, so a second param-less push here would race it.
    expect(push).not.toHaveBeenCalled();
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

  it('removes non-auth cache and resets the auth query on a DIFFERENT-user account switch', () => {
    const client = makeClient();
    client.setQueryData(['page', 'x'], { foo: 1 }); // previous user's non-auth cache
    const clearSpy = vi.spyOn(client, 'clear');
    const resetSpy = vi.spyOn(client, 'resetQueries');
    renderSync(client);

    dispatchStorage(mkAccessToken('user-a'), mkAccessToken('user-b'));

    expect(clearSpy).not.toHaveBeenCalled(); // clear()+refetch is a v5 no-op
    expect(client.getQueryData(['page', 'x'])).toBeUndefined(); // predicate dropped the previous user's cache
    expect(resetSpy).toHaveBeenCalledWith({ queryKey: authKeys.me() }); // auth query reset → refetch new user
    expect(push).not.toHaveBeenCalled();
  });

  it('ignores a same-user cross-tab silent refresh (userId equal, token string differs)', () => {
    const client = makeClient();
    client.setQueryData(['page', 'x'], { foo: 1 });
    const clearSpy = vi.spyOn(client, 'clear');
    const removeSpy = vi.spyOn(client, 'removeQueries');
    const resetSpy = vi.spyOn(client, 'resetQueries');
    renderSync(client);

    // api-client writes a fresh JWT for the SAME user on /auth/refresh.
    dispatchStorage(mkAccessToken('user-a', 1), mkAccessToken('user-a', 2));

    expect(clearSpy).not.toHaveBeenCalled();
    expect(removeSpy).not.toHaveBeenCalled();
    expect(resetSpy).not.toHaveBeenCalled();
    expect(client.getQueryData(['page', 'x'])).toEqual({ foo: 1 }); // cache survives a token rotation
    expect(push).not.toHaveBeenCalled();
  });

  it('does NOT open the inline modal on a same-user silent refresh while suppressed (editor not interrupted)', () => {
    suppressed.value = true;
    const client = makeClient();
    renderSync(client);

    let inlineFired = false;
    const onExpired = () => {
      inlineFired = true;
    };
    window.addEventListener('auth:session-expired', onExpired);
    dispatchStorage(mkAccessToken('user-a', 1), mkAccessToken('user-a', 2));
    window.removeEventListener('auth:session-expired', onExpired);

    expect(inlineFired).toBe(false); // same user → no spurious "session expired" modal over the editor
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
