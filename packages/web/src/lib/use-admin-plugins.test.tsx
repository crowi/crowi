import { act, createElement, type PropsWithChildren } from 'react';
import { cleanup, renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { makeApiResponse } from './test-utils/mocks';

/**
 * feature-plugin-config-readiness (AC-5) — `useUpdateAdminPluginConfig`'s
 * `onSuccess` must invalidate the readiness query key alongside the
 * existing config/list keys, so a save that resolves (or introduces) a
 * readiness issue is reflected on the next refetch rather than showing
 * the pre-save snapshot.
 */

const { updateConfigPut } = vi.hoisted(() => ({ updateConfigPut: vi.fn() }));
vi.mock('./api-client', () => ({
  apiClient: {
    admin: {
      plugins: {
        config: { $put: updateConfigPut },
      },
    },
  },
}));

import { adminPluginsKeys, useUpdateAdminPluginConfig } from './use-admin-plugins';

function makeClient(): QueryClient {
  return new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 60_000 } } });
}

function wrapperFor(client: QueryClient) {
  function Wrapper({ children }: PropsWithChildren) {
    return createElement(QueryClientProvider, { client }, children);
  }
  return Wrapper;
}

beforeEach(() => {
  updateConfigPut.mockReset();
});

afterEach(() => {
  cleanup();
});

describe('useUpdateAdminPluginConfig — readiness invalidation', () => {
  it('invalidates the readiness query key on a successful save', async () => {
    updateConfigPut.mockResolvedValue(makeApiResponse(200, { ok: true, hotReloaded: true, reconfigureFailed: false }));

    const client = makeClient();
    // Seed a stale readiness snapshot — the assertion is that this cache
    // entry becomes invalidated (not merely left alone) after the save.
    client.setQueryData(adminPluginsKeys.readiness(), {
      issues: [
        { name: '@crowi/plugin-storage-aws-s3', adminPlacement: { section: 'storage', label: 'AWS S3' }, fields: [{ name: 'bucket', configured: false }] },
      ],
    });
    expect(client.getQueryState(adminPluginsKeys.readiness())?.isInvalidated).toBe(false);

    const { result } = renderHook(() => useUpdateAdminPluginConfig('@crowi/plugin-storage-aws-s3'), {
      wrapper: wrapperFor(client),
    });

    await act(async () => {
      await result.current.mutateAsync({ values: { bucket: 'my-bucket' } });
    });

    await waitFor(() => expect(client.getQueryState(adminPluginsKeys.readiness())?.isInvalidated).toBe(true));
  });

  it('also invalidates the existing plugin-config and plugin-list keys (regression guard)', async () => {
    updateConfigPut.mockResolvedValue(makeApiResponse(200, { ok: true, hotReloaded: true, reconfigureFailed: false }));

    const client = makeClient();
    client.setQueryData(adminPluginsKeys.list(), { plugins: [] });
    client.setQueryData(['admin', 'plugins', '@crowi/plugin-storage-aws-s3', 'config', 'ja'], { name: '', fields: [], values: {} });

    const { result } = renderHook(() => useUpdateAdminPluginConfig('@crowi/plugin-storage-aws-s3'), {
      wrapper: wrapperFor(client),
    });

    await act(async () => {
      await result.current.mutateAsync({ values: { bucket: 'my-bucket' } });
    });

    await waitFor(() => {
      expect(client.getQueryState(adminPluginsKeys.list())?.isInvalidated).toBe(true);
      expect(client.getQueryState(['admin', 'plugins', '@crowi/plugin-storage-aws-s3', 'config', 'ja'])?.isInvalidated).toBe(true);
    });
  });

  it('does not invalidate readiness (or anything else) when the save fails', async () => {
    updateConfigPut.mockResolvedValue(makeApiResponse(500, {}));

    const client = makeClient();
    client.setQueryData(adminPluginsKeys.readiness(), { issues: [] });

    const { result } = renderHook(() => useUpdateAdminPluginConfig('@crowi/plugin-storage-aws-s3'), {
      wrapper: wrapperFor(client),
    });

    await act(async () => {
      await result.current.mutateAsync({ values: { bucket: 'my-bucket' } }).catch(() => undefined);
    });

    expect(client.getQueryState(adminPluginsKeys.readiness())?.isInvalidated).toBe(false);
  });
});

describe('useUpdateAdminPluginConfig — verificationResults wire normalization (feature-plugin-config-live-verification AC-6)', () => {
  it('passes an already-present verificationResults array through unchanged', async () => {
    updateConfigPut.mockResolvedValue(
      makeApiResponse(200, {
        ok: true,
        hotReloaded: true,
        reconfigureFailed: false,
        verificationResults: [{ plugin: '@crowi/plugin-storage-aws-s3', status: 'ok' }],
      }),
    );

    const { result } = renderHook(() => useUpdateAdminPluginConfig('@crowi/plugin-storage-aws-s3'), {
      wrapper: wrapperFor(makeClient()),
    });

    let response: unknown;
    await act(async () => {
      response = await result.current.mutateAsync({ values: { bucket: 'my-bucket' } });
    });

    expect(response).toMatchObject({ verificationResults: [{ plugin: '@crowi/plugin-storage-aws-s3', status: 'ok' }] });
  });

  it('normalizes a NEW-api empty array through unchanged (no verification ran)', async () => {
    updateConfigPut.mockResolvedValue(makeApiResponse(200, { ok: true, hotReloaded: true, reconfigureFailed: false, verificationResults: [] }));

    const { result } = renderHook(() => useUpdateAdminPluginConfig('@crowi/plugin-storage-aws-s3'), {
      wrapper: wrapperFor(makeClient()),
    });

    let response: unknown;
    await act(async () => {
      response = await result.current.mutateAsync({ values: { bucket: 'my-bucket' } });
    });

    expect(response).toMatchObject({ verificationResults: [] });
  });

  it('normalizes an OLD-api 200 response missing the field entirely to an empty array (rolling-deploy compat)', async () => {
    // No `verificationResults` key at all — exactly what an api replica
    // that predates this feature sends.
    updateConfigPut.mockResolvedValue(makeApiResponse(200, { ok: true, hotReloaded: true, reconfigureFailed: false }));

    const { result } = renderHook(() => useUpdateAdminPluginConfig('@crowi/plugin-storage-aws-s3'), {
      wrapper: wrapperFor(makeClient()),
    });

    let response: unknown;
    await act(async () => {
      response = await result.current.mutateAsync({ values: { bucket: 'my-bucket' } });
    });

    expect(response).toMatchObject({ verificationResults: [] });
  });
});
