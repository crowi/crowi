import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, renderHook } from '@testing-library/react';
import { createElement, type PropsWithChildren } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Mock `apiClient` so the mutation hits our fake instead of the network
// (matches use-admin-mail-settings.test.ts's pattern).
const { securityGet, securityPut } = vi.hoisted(() => ({
  securityGet: vi.fn(),
  securityPut: vi.fn(),
}));
vi.mock('./api-client', () => ({
  apiClient: { admin: { security: { $get: securityGet, $put: securityPut } } },
}));

import { appInfoKeys } from './use-app-info';
import { adminAppSettingsKeys } from './use-admin-app-settings';
import { useUpdateAdminSecuritySettings } from './use-admin-security';

function makeClient() {
  return new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
}

function wrapperFor(client: QueryClient) {
  const wrapper = ({ children }: PropsWithChildren) => createElement(QueryClientProvider, { client }, children);
  return wrapper;
}

beforeEach(() => {
  securityGet.mockReset();
  securityPut.mockReset();
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('useUpdateAdminSecuritySettings — invalidation (feature-admin-app-registration-mode AC-11)', () => {
  it('invalidates the app settings query after a successful security update', async () => {
    const updated = { registrationMode: 'Closed' as const, registrationWhiteList: [], linkCardEnabled: true };
    securityPut.mockResolvedValue({ status: 200, json: async () => updated });

    const client = makeClient();
    const invalidateSpy = vi.spyOn(client, 'invalidateQueries');
    const { result } = renderHook(() => useUpdateAdminSecuritySettings(), { wrapper: wrapperFor(client) });

    await act(async () => {
      await result.current.mutateAsync(updated);
    });

    const keys = invalidateSpy.mock.calls.map((c) => c[0]?.queryKey);
    expect(keys).toContainEqual(adminAppSettingsKeys.settings);
    expect(keys).toContainEqual(appInfoKeys.all);
  });
});
