import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, renderHook, waitFor } from '@testing-library/react';
import { createElement, type PropsWithChildren } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Mock `apiClient` so mutations hit our fake instead of the network
// (matches use-claim-page-link-access.test.ts's pattern).
const { mailGet, mailPut, mailTestPost } = vi.hoisted(() => ({
  mailGet: vi.fn(),
  mailPut: vi.fn(),
  mailTestPost: vi.fn(),
}));
vi.mock('./api-client', () => ({
  apiClient: { admin: { mail: { $get: mailGet, $put: mailPut, test: { $post: mailTestPost } } } },
}));

import { adminPluginsKeys } from './use-admin-plugins';
import { MailTestFailure, adminMailSettingsKeys, useSendTestMail, useUpdateMailSettings } from './use-admin-mail-settings';

function makeClient() {
  return new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
}

function wrapperFor(client: QueryClient) {
  const wrapper = ({ children }: PropsWithChildren) => createElement(QueryClientProvider, { client }, children);
  return wrapper;
}

beforeEach(() => {
  mailGet.mockReset();
  mailPut.mockReset();
  mailTestPost.mockReset();
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('useSendTestMail (feature-core-config-readiness-and-mail AC-5/AC-6)', () => {
  it('resolves normally on 200', async () => {
    mailTestPost.mockResolvedValue({ status: 200, json: async () => ({ ok: true, to: 'admin@example.com' }) });

    const client = makeClient();
    const { result } = renderHook(() => useSendTestMail(), { wrapper: wrapperFor(client) });

    await act(async () => {
      const response = await result.current.mutateAsync();
      expect(response).toEqual({ ok: true, to: 'admin@example.com' });
    });
  });

  it('throws a MailTestFailure carrying only the code — never the wire message — for MAIL_FROM_NOT_CONFIGURED', async () => {
    mailTestPost.mockResolvedValue({
      status: 502,
      json: async () => ({ error: { code: 'MAIL_FROM_NOT_CONFIGURED', message: 'The mail sender address is not configured.' } }),
    });

    const client = makeClient();
    const { result } = renderHook(() => useSendTestMail(), { wrapper: wrapperFor(client) });

    let caught: unknown;
    await act(async () => {
      try {
        await result.current.mutateAsync();
      } catch (err) {
        caught = err;
      }
    });

    expect(caught).toBeInstanceOf(MailTestFailure);
    expect((caught as MailTestFailure).code).toBe('MAIL_FROM_NOT_CONFIGURED');
  });

  it('throws a MailTestFailure carrying only the code for MAIL_TEST_FAILED — the raw transport detail never reaches the caller', async () => {
    mailTestPost.mockResolvedValue({
      status: 502,
      json: async () => ({ error: { code: 'MAIL_TEST_FAILED', message: 'connect ECONNREFUSED 127.0.0.1:25' } }),
    });

    const client = makeClient();
    const { result } = renderHook(() => useSendTestMail(), { wrapper: wrapperFor(client) });

    let caught: unknown;
    await act(async () => {
      try {
        await result.current.mutateAsync();
      } catch (err) {
        caught = err;
      }
    });

    expect(caught).toBeInstanceOf(MailTestFailure);
    const failure = caught as MailTestFailure;
    expect(failure.code).toBe('MAIL_TEST_FAILED');
    expect(failure.message).not.toContain('ECONNREFUSED');
  });

  it('falls back to MAIL_TEST_FAILED when the 502 body has no code', async () => {
    mailTestPost.mockResolvedValue({ status: 502, json: async () => ({}) });

    const client = makeClient();
    const { result } = renderHook(() => useSendTestMail(), { wrapper: wrapperFor(client) });

    let caught: unknown;
    await act(async () => {
      try {
        await result.current.mutateAsync();
      } catch (err) {
        caught = err;
      }
    });

    expect(caught).toBeInstanceOf(MailTestFailure);
    expect((caught as MailTestFailure).code).toBe('MAIL_TEST_FAILED');
  });

  it('throws a plain (localized, unauthorized) Error — not MailTestFailure — on 401/403', async () => {
    mailTestPost.mockResolvedValue({ status: 403, json: async () => ({}) });

    const client = makeClient();
    const { result } = renderHook(() => useSendTestMail(), { wrapper: wrapperFor(client) });

    let caught: unknown;
    await act(async () => {
      try {
        await result.current.mutateAsync();
      } catch (err) {
        caught = err;
      }
    });

    expect(caught).not.toBeInstanceOf(MailTestFailure);
    expect(caught).toBeInstanceOf(Error);
  });
});

describe('useUpdateMailSettings — readiness invalidation (feature-core-config-readiness-and-mail)', () => {
  it('invalidates both the mail settings query and the shared admin plugin readiness query on success', async () => {
    mailPut.mockResolvedValue({ status: 200, json: async () => ({ ok: true }) });

    const client = makeClient();
    const invalidateSpy = vi.spyOn(client, 'invalidateQueries');
    const { result } = renderHook(() => useUpdateMailSettings(), { wrapper: wrapperFor(client) });

    await act(async () => {
      await result.current.mutateAsync({ from: 'noreply@example.com' });
    });

    await waitFor(() => {
      const keys = invalidateSpy.mock.calls.map((c) => c[0]?.queryKey);
      expect(keys).toContainEqual(adminMailSettingsKeys.settings);
      expect(keys).toContainEqual(adminPluginsKeys.readiness());
    });
  });
});
