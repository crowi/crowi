import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, renderHook } from '@testing-library/react';
import { createElement, type PropsWithChildren } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Mock `apiClient` at the module boundary (matches
// use-admin-artifact.test.ts's pattern) so the mutation hits our fake
// instead of the network.
const { mintArtifactUrl } = vi.hoisted(() => ({ mintArtifactUrl: vi.fn() }));
vi.mock('./api-client', () => ({
  apiClient: { pages: { ':id': { 'artifact-url': { $post: mintArtifactUrl } } } },
}));

import { ArtifactUrlUnavailableFailure, useMintArtifactUrl } from './use-artifact-url';

function makeClient() {
  return new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
}

function wrapperFor(client: QueryClient) {
  const wrapper = ({ children }: PropsWithChildren) => createElement(QueryClientProvider, { client }, children);
  return wrapper;
}

beforeEach(() => {
  mintArtifactUrl.mockReset();
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('useMintArtifactUrl', () => {
  it('200: resolves with the minted url and expiry, and forwards an explicit revisionId', async () => {
    mintArtifactUrl.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ url: 'https://artifacts.example.net/api/artifact/p1/r1?t=tok', expiresAt: '2026-05-01T00:01:00.000Z' }),
    });

    const client = makeClient();
    const { result } = renderHook(() => useMintArtifactUrl(), { wrapper: wrapperFor(client) });

    let resolved: unknown;
    await act(async () => {
      resolved = await result.current.mutateAsync({ pageId: 'p1', revisionId: 'r1' });
    });

    expect(resolved).toEqual({ url: 'https://artifacts.example.net/api/artifact/p1/r1?t=tok', expiresAt: '2026-05-01T00:01:00.000Z' });
    expect(mintArtifactUrl).toHaveBeenCalledWith({ param: { id: 'p1' }, json: { revisionId: 'r1' } });
  });

  it('omits revisionId from the request body when not provided', async () => {
    mintArtifactUrl.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ url: 'https://artifacts.example.net/api/artifact/p1/r1?t=tok', expiresAt: '2026-05-01T00:01:00.000Z' }),
    });

    const client = makeClient();
    const { result } = renderHook(() => useMintArtifactUrl(), { wrapper: wrapperFor(client) });

    await act(async () => {
      await result.current.mutateAsync({ pageId: 'p1' });
    });

    expect(mintArtifactUrl).toHaveBeenCalledWith({ param: { id: 'p1' }, json: {} });
  });

  it('400 NOT_AN_ARTIFACT: throws ArtifactUrlUnavailableFailure carrying the reason', async () => {
    mintArtifactUrl.mockResolvedValue({
      ok: false,
      status: 400,
      json: async () => ({ error: { code: 'ARTIFACT_URL_UNAVAILABLE', reason: 'NOT_AN_ARTIFACT', message: 'not an artifact' } }),
    });

    const client = makeClient();
    const { result } = renderHook(() => useMintArtifactUrl(), { wrapper: wrapperFor(client) });

    let caught: unknown;
    await act(async () => {
      try {
        await result.current.mutateAsync({ pageId: 'p1' });
      } catch (err) {
        caught = err;
      }
    });

    expect(caught).toBeInstanceOf(ArtifactUrlUnavailableFailure);
    expect((caught as ArtifactUrlUnavailableFailure).reason).toBe('NOT_AN_ARTIFACT');
  });

  it('422 ARTIFACT_DELIVERY_NOT_CONFIGURED: throws ArtifactUrlUnavailableFailure carrying the reason, with a fixed localized message (not the server message)', async () => {
    mintArtifactUrl.mockResolvedValue({
      ok: false,
      status: 422,
      json: async () => ({ error: { code: 'ARTIFACT_URL_UNAVAILABLE', reason: 'ARTIFACT_DELIVERY_NOT_CONFIGURED', message: 'do not leak this raw text' } }),
    });

    const client = makeClient();
    const { result } = renderHook(() => useMintArtifactUrl(), { wrapper: wrapperFor(client) });

    let caught: unknown;
    await act(async () => {
      try {
        await result.current.mutateAsync({ pageId: 'p1' });
      } catch (err) {
        caught = err;
      }
    });

    expect(caught).toBeInstanceOf(ArtifactUrlUnavailableFailure);
    expect((caught as ArtifactUrlUnavailableFailure).reason).toBe('ARTIFACT_DELIVERY_NOT_CONFIGURED');
    expect((caught as Error).message).not.toContain('do not leak this raw text');
  });

  it('404: throws a plain Error (not ArtifactUrlUnavailableFailure), localized and not the raw server message', async () => {
    mintArtifactUrl.mockResolvedValue({
      ok: false,
      status: 404,
      json: async () => ({ error: { code: 'PAGE_NOT_FOUND', message: 'do not leak this raw text either' } }),
    });

    const client = makeClient();
    const { result } = renderHook(() => useMintArtifactUrl(), { wrapper: wrapperFor(client) });

    let caught: unknown;
    await act(async () => {
      try {
        await result.current.mutateAsync({ pageId: 'p1' });
      } catch (err) {
        caught = err;
      }
    });

    expect(caught).not.toBeInstanceOf(ArtifactUrlUnavailableFailure);
    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).not.toContain('do not leak this raw text either');
    expect((caught as Error).message.length).toBeGreaterThan(0);
  });

  it('drops the minted response (URL + token) from the MutationCache once reset — proves gcTime: 0, not just the observer-local reset, purges it', async () => {
    mintArtifactUrl.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ url: 'https://artifacts.example.net/api/artifact/p1/r1?t=SECRET_TOKEN', expiresAt: '2026-05-01T00:01:00.000Z' }),
    });

    const client = makeClient();
    const { result } = renderHook(() => useMintArtifactUrl(), { wrapper: wrapperFor(client) });

    await act(async () => {
      await result.current.mutateAsync({ pageId: 'p1', revisionId: 'r1' });
    });

    // Sanity: the cache really does hold the secret right after success —
    // otherwise the assertion below wouldn't be proving the reset path did
    // anything.
    const holdsSecretBeforeReset = client
      .getMutationCache()
      .getAll()
      .some((mutation) => JSON.stringify(mutation.state.data).includes('SECRET_TOKEN'));
    expect(holdsSecretBeforeReset).toBe(true);

    await act(async () => {
      result.current.reset();
      // `gcTime: 0` schedules removal on the next timer tick (detaching the
      // last observer), not synchronously within `reset()` itself.
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(client.getMutationCache().getAll()).toHaveLength(0);
  });

  it('is never served from a cache — pressing run twice always mints twice', async () => {
    mintArtifactUrl.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ url: 'https://artifacts.example.net/api/artifact/p1/r1?t=tok', expiresAt: '2026-05-01T00:01:00.000Z' }),
    });

    const client = makeClient();
    const { result } = renderHook(() => useMintArtifactUrl(), { wrapper: wrapperFor(client) });

    await act(async () => {
      await result.current.mutateAsync({ pageId: 'p1', revisionId: 'r1' });
    });
    await act(async () => {
      await result.current.mutateAsync({ pageId: 'p1', revisionId: 'r1' });
    });

    expect(mintArtifactUrl).toHaveBeenCalledTimes(2);
  });
});
