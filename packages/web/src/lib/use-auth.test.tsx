import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act } from 'react';
import { renderHook, render, cleanup, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createElement, type PropsWithChildren } from 'react';

/**
 * Tests for the React-Query-backed `useAuth` thin wrapper.
 *
 * Covers the spec truth table + the user-observable fixes:
 *   - token absent → enabled:false, isLoading:false, no /auth/me (AC3 / AC8)
 *   - token present → optimistically authed while fetching (AC13), then user
 *   - single shared fetch across multiple consumers (AC2)
 *   - 401 → clearTokens, deauth, no retry (AC7)
 *   - transient 5xx → stays authed + retains the previous user (AC14)
 *   - logout → server logout + clearTokens + queryClient.clear() + /login (AC5)
 *
 * `./api-client` is mocked so /auth/me + /auth/logout hit our fakes; the real
 * `auth-token` / `auth-token-store` drive the reactive presence gate.
 */

// --- next/navigation -------------------------------------------------
const { push } = vi.hoisted(() => ({ push: vi.fn() }));
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push, replace: vi.fn(), back: vi.fn() }),
}));

// --- api client ------------------------------------------------------
const { meGet, logoutPost } = vi.hoisted(() => ({ meGet: vi.fn(), logoutPost: vi.fn() }));
vi.mock('./api-client', () => ({
  apiClient: { auth: { me: { $get: meGet }, logout: { $post: logoutPost } } },
}));

import { useAuth } from './use-auth';
import { makeApiResponse } from './test-utils/mocks';

interface UserShape {
  id: string;
  username: string;
  email: string;
  name: string;
  status: number;
  admin?: boolean;
  createdAt: string;
}

function mkUser(over?: Partial<UserShape>): UserShape {
  return { id: 'u1', username: 'alice', email: 'a@example.com', name: 'Alice', status: 1, admin: false, createdAt: '2024-01-01T00:00:00Z', ...over };
}

function makeClient(): QueryClient {
  // gcTime non-zero so a cache entry survives long enough for assertions;
  // retry:false mirrors the hook so a failed fetch settles immediately.
  return new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 60_000 } } });
}

function wrapperFor(client: QueryClient) {
  function Wrapper({ children }: PropsWithChildren) {
    return createElement(QueryClientProvider, { client }, children);
  }
  return Wrapper;
}

beforeEach(() => {
  push.mockReset();
  meGet.mockReset();
  logoutPost.mockReset();
  localStorage.clear();
});

afterEach(() => {
  cleanup();
});

describe('useAuth', () => {
  it('stays idle and unauthenticated with no token (no /auth/me)', () => {
    const { result } = renderHook(() => useAuth(), { wrapper: wrapperFor(makeClient()) });

    expect(result.current.isAuthenticated).toBe(false);
    expect(result.current.isLoading).toBe(false);
    expect(result.current.user).toBeNull();
    expect(meGet).not.toHaveBeenCalled();
  });

  it('is optimistically authenticated while /auth/me is in flight, then resolves the user', async () => {
    localStorage.setItem('accessToken', 'tok');
    meGet.mockResolvedValue(makeApiResponse(200, { user: mkUser() }));

    const { result } = renderHook(() => useAuth(), { wrapper: wrapperFor(makeClient()) });

    // Authed immediately on hasToken — no full-screen "logged out" flash.
    expect(result.current.isAuthenticated).toBe(true);

    await waitFor(() => expect(result.current.user).toEqual(mkUser()));
    expect(result.current.isLoading).toBe(false);
    expect(meGet).toHaveBeenCalledTimes(1);
  });

  it('shares one /auth/me fetch across multiple consumers', async () => {
    localStorage.setItem('accessToken', 'tok');
    meGet.mockResolvedValue(makeApiResponse(200, { user: mkUser() }));

    function Double() {
      useAuth();
      useAuth();
      return null;
    }
    const client = makeClient();
    render(createElement(QueryClientProvider, { client }, createElement(Double)));

    await waitFor(() => expect(meGet).toHaveBeenCalledTimes(1));
  });

  it('on 401 clears tokens, deauthenticates, and does not retry', async () => {
    localStorage.setItem('accessToken', 'tok');
    meGet.mockResolvedValue(makeApiResponse(401, {}));

    const { result } = renderHook(() => useAuth(), { wrapper: wrapperFor(makeClient()) });

    await waitFor(() => expect(result.current.isAuthenticated).toBe(false));
    expect(result.current.user).toBeNull();
    expect(localStorage.getItem('accessToken')).toBeNull();
    expect(meGet).toHaveBeenCalledTimes(1); // retry:false
  });

  it('keeps the authed user on a transient 5xx (no clearTokens, data retained)', async () => {
    localStorage.setItem('accessToken', 'tok');
    meGet.mockResolvedValueOnce(makeApiResponse(200, { user: mkUser() }));

    const { result } = renderHook(() => useAuth(), { wrapper: wrapperFor(makeClient()) });
    await waitFor(() => expect(result.current.user).toEqual(mkUser()));

    // A later refetch hits a 5xx blip.
    meGet.mockResolvedValue(makeApiResponse(503, {}));
    await act(async () => {
      await result.current.refetch();
    });

    expect(result.current.isAuthenticated).toBe(true); // hasToken still true
    expect(result.current.user).toEqual(mkUser()); // error reducer retained data
    expect(localStorage.getItem('accessToken')).toBe('tok'); // not cleared
  });

  it('logout server-logs-out, clears tokens + ALL cache, and redirects to /login', async () => {
    localStorage.setItem('accessToken', 'tok');
    localStorage.setItem('refreshToken', 'rtok');
    meGet.mockResolvedValue(makeApiResponse(200, { user: mkUser() }));
    logoutPost.mockResolvedValue(makeApiResponse(200, { message: 'ok' }));

    const client = makeClient();
    // Seed a previous-user cache entry that must NOT survive logout.
    client.setQueryData(['page', 'x'], { foo: 1 });

    const { result } = renderHook(() => useAuth(), { wrapper: wrapperFor(client) });
    await waitFor(() => expect(result.current.user).toEqual(mkUser()));

    await act(async () => {
      await result.current.logout();
    });

    expect(logoutPost).toHaveBeenCalledWith({ json: { refreshToken: 'rtok' } });
    expect(localStorage.getItem('accessToken')).toBeNull();
    expect(client.getQueryData(['page', 'x'])).toBeUndefined(); // cross-user leak prevented
    expect(push).toHaveBeenCalledWith('/login');
    expect(result.current.isAuthenticated).toBe(false);
  });
});
