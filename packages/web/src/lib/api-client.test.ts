import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// `env()` is the next-runtime-env runtime reader. Mock it so the test can
// change its return value *between calls* — that is exactly what distinguishes
// a runtime read (correct) from a module-scope freeze (the bug this guards).
const envMock = vi.fn<(key: string) => string | undefined>();
vi.mock('./runtime-env', () => ({ env: (key: string) => envMock(key) }));

import { apiBaseUrl, apiFetch, apiOrigin, resolveApiUrl } from './api-client';

describe('api base resolution', () => {
  beforeEach(() => {
    envMock.mockReset();
  });

  it('defaults to same-origin (relative) when NEXT_PUBLIC_API_URL is unset', () => {
    envMock.mockReturnValue(undefined);
    expect(apiOrigin()).toBe('');
    expect(apiBaseUrl()).toBe('/api');
  });

  it('reads NEXT_PUBLIC_API_URL at call time, not at module load (cross-origin)', () => {
    // Simulate the real timing: the module evaluated while window.__ENV was
    // still empty (env() -> undefined), then PublicEnvScript populated it. A
    // module-scope `const API_BASE_URL = env(...)` would stay '' forever; the
    // call-time read must reflect the now-injected cross-origin origin.
    envMock.mockReturnValue(undefined);
    expect(apiBaseUrl()).toBe('/api');

    envMock.mockReturnValue('https://api.example.com');
    expect(apiOrigin()).toBe('https://api.example.com');
    expect(apiBaseUrl()).toBe('https://api.example.com/api');
  });

  it('strips a trailing slash so the base is never `…//api`', () => {
    envMock.mockReturnValue('https://api.example.com/');
    expect(apiOrigin()).toBe('https://api.example.com');
    expect(apiBaseUrl()).toBe('https://api.example.com/api');
  });
});

/**
 * `resolveApiUrl` — shared by `apiFetch` (request URLs) and
 * `RendererStylesheets` (`<link href>` values, feature-renderer-plugin-
 * boundary Phase 1). Same call-time-read + relative-when-empty-origin rule
 * as `apiOrigin`/`apiBaseUrl` above, exercised directly here instead of
 * only indirectly through a fetch call.
 */
describe('resolveApiUrl', () => {
  beforeEach(() => {
    envMock.mockReset();
  });

  it('returns the path unchanged (relative) when NEXT_PUBLIC_API_URL is unset', () => {
    envMock.mockReturnValue(undefined);
    expect(resolveApiUrl('/api/plugins/@crowi/plugin-renderer-katex/katex.css')).toBe('/api/plugins/@crowi/plugin-renderer-katex/katex.css');
  });

  it('prepends the runtime API origin, read at call time', () => {
    envMock.mockReturnValue(undefined);
    expect(resolveApiUrl('/api/app/info')).toBe('/api/app/info');

    envMock.mockReturnValue('https://api.example.com');
    expect(resolveApiUrl('/api/app/info')).toBe('https://api.example.com/api/app/info');
  });
});

/**
 * feature-auth-cookie-fallback-scope AC-3 — `apiFetch` must never send a
 * token-missing (headerless) request that would otherwise depend on the
 * (now attachment-delivery-only) `crowi.accessToken` cookie fallback. It
 * recovers a token through the existing single-flight refresh first, and
 * falls to the existing auth-invalidation path (`clearTokens` +
 * `auth:session-expired`) when that can't resolve one — without ever
 * sending the original request.
 */
describe('apiFetch — token-missing send-avoidance', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  const jsonResponse = (body: unknown, status = 200): Response =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

  beforeEach(() => {
    envMock.mockReset();
    envMock.mockReturnValue(undefined); // same-origin — relative URLs, keeps mock-URL matching simple.
    localStorage.clear();
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    localStorage.clear();
  });

  it('sends the request headerless when both tokens are absent (public routes, e.g. /auth/login, keep working)', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ ok: true }));

    const res = await apiFetch('/api/auth/login', { method: 'POST' });

    expect(res.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [, init] = fetchMock.mock.calls[0] as [unknown, RequestInit];
    expect(new Headers(init.headers).has('authorization')).toBe(false);
  });

  it('recovers the access token via the existing refresh path before sending, and never sends the request headerless', async () => {
    localStorage.setItem('refreshToken', 'refresh-1');
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ accessToken: 'fresh-access', refreshToken: 'refresh-2', expiresIn: 3600 })) // /auth/refresh
      .mockResolvedValueOnce(jsonResponse({ ok: true })); // the actual target request, now carrying a header

    const res = await apiFetch('/api/pages', { method: 'GET' });

    expect(res.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(2);

    const [refreshUrl] = fetchMock.mock.calls[0] as [unknown];
    expect(String(refreshUrl)).toContain('/auth/refresh');

    const [, targetInit] = fetchMock.mock.calls[1] as [unknown, RequestInit];
    expect(new Headers(targetInit.headers).get('authorization')).toBe('Bearer fresh-access');
    expect(localStorage.getItem('accessToken')).toBe('fresh-access');
  });

  /**
   * NEEDS_WORK round 3 — the refresh-endpoint check must be an EXACT
   * pathname match too, not `urlString.includes(REFRESH_PATH)`: a protected
   * endpoint whose query string happens to contain `/auth/refresh` (e.g. a
   * `path` filter value) must not be mistaken for the refresh call itself,
   * or it would skip the token-missing send-avoidance guard entirely and go
   * out headerless.
   */
  it('does NOT treat a protected request carrying "/auth/refresh" in its query string as the refresh endpoint', async () => {
    // Both tokens absent, not a public path — must short-circuit locally
    // without ever calling fetch, exactly like any other protected route.
    const res = await apiFetch('/api/pages?path=/auth/refresh', { method: 'GET' });

    expect(res.status).toBe(401);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('fails closed — no headerless send — when refresh cannot recover a token, falling to the existing auth-invalidation path', async () => {
    localStorage.setItem('refreshToken', 'refresh-1');
    fetchMock.mockResolvedValueOnce(jsonResponse({ error: 'invalid_grant' }, 401)); // /auth/refresh itself fails

    const dispatchSpy = vi.spyOn(window, 'dispatchEvent');
    const res = await apiFetch('/api/pages', { method: 'GET' });

    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: { code: 'AUTHENTICATION_REQUIRED', message: 'Authentication is required' } });
    // Only the refresh call happened — the original target request was never sent.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(localStorage.getItem('accessToken')).toBeNull();
    expect(localStorage.getItem('refreshToken')).toBeNull();
    expect(dispatchSpy.mock.calls.some(([e]) => (e as CustomEvent).type === 'auth:session-expired')).toBe(true);
  });

  it('sends the Bearer header directly when an access token is already present (unchanged behaviour)', async () => {
    localStorage.setItem('accessToken', 'existing-access');
    fetchMock.mockResolvedValueOnce(jsonResponse({ ok: true }));

    const res = await apiFetch('/api/pages', { method: 'GET' });

    expect(res.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [, init] = fetchMock.mock.calls[0] as [unknown, RequestInit];
    expect(new Headers(init.headers).get('authorization')).toBe('Bearer existing-access');
  });

  /**
   * NEEDS_WORK round 2 — `isPublicPath` must be an EXACT pathname match, not
   * a substring one: `/oauth/device` (public) and `/oauth/device/verify` /
   * `/oauth/device/authorize` (a different, protected / a different, public
   * route respectively) share a path prefix.
   */
  it('does NOT treat /oauth/device/verify as public just because /oauth/device is (substring-match regression)', async () => {
    // Both tokens absent, not one of the public paths — must short-circuit
    // locally without ever calling fetch.
    const res = await apiFetch('/api/oauth/device/verify', { method: 'POST' });

    expect(res.status).toBe(401);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('treats /oauth/device/authorize as public (device grant start, no session yet)', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ device_code: 'x', user_code: 'y' }));

    const res = await apiFetch('/api/oauth/device/authorize', { method: 'POST' });

    expect(res.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [, init] = fetchMock.mock.calls[0] as [unknown, RequestInit];
    expect(new Headers(init.headers).has('authorization')).toBe(false);
  });

  it('treats /installer/createAdmin as public (pre-install, no user exists yet)', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ status: 'ok' }));

    const res = await apiFetch('/api/installer/createAdmin', { method: 'POST' });

    expect(res.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [, init] = fetchMock.mock.calls[0] as [unknown, RequestInit];
    expect(new Headers(init.headers).has('authorization')).toBe(false);
  });

  /**
   * NEEDS_WORK round 2 — a caller-supplied `Authorization` header is an
   * explicit credential apiFetch must never second-guess. Previously a 401
   * on that request triggered the ambient refresh-token retry, silently
   * overwriting the caller's explicit header with a DIFFERENT (web-session)
   * principal's token.
   */
  it('never retries with a refreshed ambient token when the caller supplied an explicit Authorization header', async () => {
    localStorage.setItem('refreshToken', 'refresh-1');
    fetchMock.mockResolvedValueOnce(jsonResponse({ error: 'unauthorized' }, 401)); // the only call — no /auth/refresh call

    const res = await apiFetch('/api/pages', {
      method: 'GET',
      headers: { Authorization: 'Bearer explicit-caller-token' },
    });

    expect(res.status).toBe(401);
    // Only the one target request — never a second call to /auth/refresh,
    // and never a retried target request either.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [, init] = fetchMock.mock.calls[0] as [unknown, RequestInit];
    expect(new Headers(init.headers).get('authorization')).toBe('Bearer explicit-caller-token');
  });
});
