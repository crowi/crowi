import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, renderHook } from '@testing-library/react';
import { createElement, type PropsWithChildren } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Mock `apiClient` so the mutation hits our fake instead of the network
// (matches use-admin-mail-settings.test.ts's pattern).
const { artifactGet, artifactPut } = vi.hoisted(() => ({
  artifactGet: vi.fn(),
  artifactPut: vi.fn(),
}));
vi.mock('./api-client', () => ({
  apiClient: { admin: { artifact: { $get: artifactGet, $put: artifactPut } } },
}));

import { ArtifactSettingsRejectedFailure, useUpdateAdminArtifactSettings } from './use-admin-artifact';

function makeClient() {
  return new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
}

function wrapperFor(client: QueryClient) {
  const wrapper = ({ children }: PropsWithChildren) => createElement(QueryClientProvider, { client }, children);
  return wrapper;
}

beforeEach(() => {
  artifactGet.mockReset();
  artifactPut.mockReset();
});

afterEach(() => {
  vi.clearAllMocks();
});

/**
 * Direct coverage of `mapValidationError`'s discrimination — the reviewer
 * flagged that `artifact-form.test.tsx` mocks this hook entirely and never
 * exercises the `code`/`reason` match itself.
 */
describe('useUpdateAdminArtifactSettings — mapValidationError discrimination', () => {
  it('throws ArtifactSettingsRejectedFailure on the exact ARTIFACT_SETTINGS_REJECTED / CLIENT_URL_REQUIRED_FOR_SAME_ORIGIN pair', async () => {
    artifactPut.mockResolvedValue({
      status: 400,
      json: async () => ({ error: { code: 'ARTIFACT_SETTINGS_REJECTED', reason: 'CLIENT_URL_REQUIRED_FOR_SAME_ORIGIN', message: 'rejected' } }),
    });

    const client = makeClient();
    const { result } = renderHook(() => useUpdateAdminArtifactSettings(), { wrapper: wrapperFor(client) });

    let caught: unknown;
    await act(async () => {
      try {
        await result.current.mutateAsync({ sameOriginEnabled: true, allowWebFonts: false, maxBytes: 2 * 1024 * 1024 });
      } catch (err) {
        caught = err;
      }
    });

    expect(caught).toBeInstanceOf(ArtifactSettingsRejectedFailure);
  });

  it('falls back to a generic Error when the code matches but the reason does not', async () => {
    artifactPut.mockResolvedValue({
      status: 400,
      json: async () => ({ error: { code: 'ARTIFACT_SETTINGS_REJECTED', reason: 'SOME_OTHER_REASON', message: 'some other reason' } }),
    });

    const client = makeClient();
    const { result } = renderHook(() => useUpdateAdminArtifactSettings(), { wrapper: wrapperFor(client) });

    let caught: unknown;
    await act(async () => {
      try {
        await result.current.mutateAsync({ sameOriginEnabled: true, allowWebFonts: false, maxBytes: 2 * 1024 * 1024 });
      } catch (err) {
        caught = err;
      }
    });

    expect(caught).not.toBeInstanceOf(ArtifactSettingsRejectedFailure);
    expect(caught).toBeInstanceOf(Error);
  });

  it('falls back to a generic Error when the reason matches but the code does not', async () => {
    artifactPut.mockResolvedValue({
      status: 400,
      json: async () => ({ error: { code: 'SOME_OTHER_CODE', reason: 'CLIENT_URL_REQUIRED_FOR_SAME_ORIGIN', message: 'some other code' } }),
    });

    const client = makeClient();
    const { result } = renderHook(() => useUpdateAdminArtifactSettings(), { wrapper: wrapperFor(client) });

    let caught: unknown;
    await act(async () => {
      try {
        await result.current.mutateAsync({ sameOriginEnabled: true, allowWebFonts: false, maxBytes: 2 * 1024 * 1024 });
      } catch (err) {
        caught = err;
      }
    });

    expect(caught).not.toBeInstanceOf(ArtifactSettingsRejectedFailure);
    expect(caught).toBeInstanceOf(Error);
  });
});
