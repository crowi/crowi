import { PageGrantEnum } from '@crowi/api-contract';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, renderHook, waitFor } from '@testing-library/react';
import { createElement, type PropsWithChildren } from 'react';
import { describe, expect, it, vi } from 'vitest';

const { putGrant } = vi.hoisted(() => ({ putGrant: vi.fn() }));
vi.mock('./api-client', () => ({ apiClient: { pages: { grant: { $put: putGrant } } } }));

import { type UsePageGrantControlOptions, usePageGrantControl } from './use-page-grant-control';

function makeGrantControlContext() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  const invalidateSpy = vi.spyOn(client, 'invalidateQueries');
  const wrapper = ({ children }: PropsWithChildren) => createElement(QueryClientProvider, { client }, children);
  return { client, invalidateSpy, wrapper };
}

const basePage = { _id: 'p1', grant: PageGrantEnum.PUBLIC, status: 'published' } as UsePageGrantControlOptions['page'];

function options(overrides: Partial<UsePageGrantControlOptions> = {}): UsePageGrantControlOptions {
  return { page: basePage, actorId: 'u1', authorityMode: 'legacy', enabled: true, isPageRefreshing: false, isPageError: false, ...overrides };
}

function deferredPut() {
  let release: () => void = () => {};
  putGrant.mockImplementation(
    () =>
      new Promise((resolve) => {
        release = () => resolve({ ok: false, status: 500, json: async () => ({}) });
      }),
  );
  return () => release();
}

function okResponse(grant: number) {
  return { ok: true, status: 200, json: async () => ({ page: { _id: 'p1', grant, grantedUsers: [] } }) };
}

describe('usePageGrantControl — what is sent', () => {
  it('sends one PUT with only page_id and grant for a confirmed change', async () => {
    putGrant.mockResolvedValue(okResponse(PageGrantEnum.OWNER));
    const { wrapper } = makeGrantControlContext();
    const { result } = renderHook(() => usePageGrantControl(options()), { wrapper });

    await act(async () => {
      await result.current.requestChange(PageGrantEnum.OWNER);
    });

    expect(putGrant).toHaveBeenCalledTimes(1);
    expect(putGrant).toHaveBeenCalledWith({ json: { page_id: 'p1', grant: PageGrantEnum.OWNER } });
  });

  it('sends nothing for the same grant, an unsendable grant, or a cancelled confirmation', async () => {
    const { wrapper } = makeGrantControlContext();
    const { result } = renderHook(() => usePageGrantControl(options({ page: { ...basePage!, grant: PageGrantEnum.SPECIFIED } })), { wrapper });

    await act(async () => {
      await result.current.requestChange(PageGrantEnum.SPECIFIED);
      await result.current.requestChange(99);
    });
    expect(result.current.confirmation).toBeNull();

    await act(async () => {
      await result.current.requestChange(PageGrantEnum.PUBLIC);
    });
    expect(result.current.confirmation).toEqual({ pageId: 'p1', fromGrant: PageGrantEnum.SPECIFIED, toGrant: PageGrantEnum.PUBLIC });
    act(() => result.current.cancelConfirmation());
    expect(result.current.confirmation).toBeNull();
    await act(async () => {
      await result.current.confirmChange();
    });
    expect(putGrant).not.toHaveBeenCalled();
  });

  it('never sends for an unknown / missing grant or an unsaved page id', async () => {
    const { wrapper } = makeGrantControlContext();
    const unknown = renderHook(() => usePageGrantControl(options({ page: { ...basePage!, grant: 77 } })), { wrapper });
    const missing = renderHook(() => usePageGrantControl(options({ page: { ...basePage!, grant: undefined } })), { wrapper });
    const unsaved = renderHook(() => usePageGrantControl(options({ page: { ...basePage!, _id: '' } })), { wrapper });

    for (const r of [unknown, missing, unsaved]) {
      expect(r.result.current.disabled).toBe(true);
      await act(async () => {
        await r.result.current.requestChange(PageGrantEnum.OWNER);
      });
    }
    expect(unknown.result.current.currentGrant).toBeNull();
    expect(putGrant).not.toHaveBeenCalled();
  });

  it('confirms a specified-users reset with one PUT', async () => {
    putGrant.mockResolvedValue(okResponse(PageGrantEnum.PUBLIC));
    const { wrapper } = makeGrantControlContext();
    const { result } = renderHook(() => usePageGrantControl(options({ page: { ...basePage!, grant: PageGrantEnum.SPECIFIED } })), { wrapper });

    await act(async () => {
      await result.current.requestChange(PageGrantEnum.PUBLIC);
    });
    expect(putGrant).not.toHaveBeenCalled();
    await act(async () => {
      await result.current.confirmChange();
    });
    expect(putGrant).toHaveBeenCalledTimes(1);
    expect(putGrant).toHaveBeenCalledWith({ json: { page_id: 'p1', grant: PageGrantEnum.PUBLIC } });
  });
});

describe('usePageGrantControl — when it is disabled', () => {
  it.each([
    ['model authority', { authorityMode: 'model' as const }],
    ['unknown authority', { authorityMode: null }],
    ['host disabled', { enabled: false }],
    ['no actor', { actorId: null }],
    ['own query refetching', { isPageRefreshing: true }],
    ['own query in error', { isPageError: true }],
    ['deleted page', { page: { ...basePage!, status: 'deleted' as const } }],
    ['redirect stub', { page: { ...basePage!, redirectTo: '/elsewhere' } }],
  ])('%s', async (_name, overrides) => {
    const { wrapper } = makeGrantControlContext();
    const { result } = renderHook(() => usePageGrantControl(options(overrides as Partial<UsePageGrantControlOptions>)), { wrapper });
    expect(result.current.disabled).toBe(true);
    await act(async () => {
      await result.current.requestChange(PageGrantEnum.OWNER);
    });
    expect(putGrant).not.toHaveBeenCalled();
  });

  it('follows only the query state it is handed (a success on this view re-enables it)', () => {
    const { wrapper } = makeGrantControlContext();
    const { result, rerender } = renderHook((props: UsePageGrantControlOptions) => usePageGrantControl(props), {
      wrapper,
      initialProps: options({ isPageError: true }),
    });
    expect(result.current.disabled).toBe(true);
    rerender(options({ isPageError: false }));
    expect(result.current.disabled).toBe(false);
  });
});

describe('usePageGrantControl — duplicate sends', () => {
  it('sends once for two same-tick requests', async () => {
    const release = deferredPut();
    const { wrapper } = makeGrantControlContext();
    const { result } = renderHook(() => usePageGrantControl(options()), { wrapper });

    await act(async () => {
      void result.current.requestChange(PageGrantEnum.OWNER);
      void result.current.requestChange(PageGrantEnum.RESTRICTED);
    });
    expect(putGrant).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(result.current.isSaving).toBe(true));
    expect(result.current.disabled).toBe(true);
    await act(async () => release());
    await waitFor(() => expect(result.current.isSaving).toBe(false));
  });

  it('sends once across two controllers sharing a QueryClient, and not for a different page', async () => {
    const resolvers: Array<() => void> = [];
    putGrant.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolvers.push(() => resolve({ ok: false, status: 500, json: async () => ({}) }));
        }),
    );
    const { wrapper } = makeGrantControlContext();
    const a = renderHook(() => usePageGrantControl(options()), { wrapper });
    const b = renderHook(() => usePageGrantControl(options()), { wrapper });
    const other = renderHook(() => usePageGrantControl(options({ page: { ...basePage!, _id: 'p2' } })), { wrapper });

    await act(async () => {
      void a.result.current.requestChange(PageGrantEnum.OWNER);
    });
    await act(async () => {
      void b.result.current.requestChange(PageGrantEnum.RESTRICTED);
      void other.result.current.requestChange(PageGrantEnum.RESTRICTED);
    });
    expect(putGrant).toHaveBeenCalledTimes(2);
    expect(putGrant.mock.calls.map((c) => c[0].json.page_id).sort()).toEqual(['p1', 'p2']);
    await act(async () => resolvers.forEach((r) => r()));
  });
});

describe('usePageGrantControl — failure', () => {
  it('shows the error, causes no GET / invalidation, and can be retried', async () => {
    putGrant.mockResolvedValueOnce({ ok: false, status: 500, json: async () => ({ error: 'secret server text' }) });
    putGrant.mockResolvedValueOnce(okResponse(PageGrantEnum.OWNER));
    const { invalidateSpy, wrapper } = makeGrantControlContext();
    const { result } = renderHook(() => usePageGrantControl(options()), { wrapper });

    await act(async () => {
      await result.current.requestChange(PageGrantEnum.OWNER);
    });
    expect(result.current.error).not.toBeNull();
    expect(result.current.error).not.toContain('secret');
    expect(invalidateSpy).not.toHaveBeenCalled();
    expect(result.current.disabled).toBe(false);

    await act(async () => {
      await result.current.requestChange(PageGrantEnum.OWNER);
    });
    expect(putGrant).toHaveBeenCalledTimes(2);
    expect(result.current.error).toBeNull();
  });

  it('does not show an old error on another page or actor', async () => {
    putGrant.mockResolvedValue({ ok: false, status: 500, json: async () => ({}) });
    const { wrapper } = makeGrantControlContext();
    const { result, rerender } = renderHook((props: UsePageGrantControlOptions) => usePageGrantControl(props), { wrapper, initialProps: options() });
    await act(async () => {
      await result.current.requestChange(PageGrantEnum.OWNER);
    });
    expect(result.current.error).not.toBeNull();
    rerender(options({ page: { ...basePage!, _id: 'p2' } }));
    expect(result.current.error).toBeNull();
  });

  it('drops an unsent confirmation when the page, actor, authority or current grant changes', async () => {
    const { wrapper } = makeGrantControlContext();
    const specified = { ...basePage!, grant: PageGrantEnum.SPECIFIED };
    const { result, rerender } = renderHook((props: UsePageGrantControlOptions) => usePageGrantControl(props), {
      wrapper,
      initialProps: options({ page: specified }),
    });

    for (const changed of [
      options({ page: { ...specified, _id: 'p2' } }),
      options({ page: specified, actorId: 'u2' }),
      options({ page: specified, authorityMode: 'model' }),
      options({ page: { ...specified, grant: PageGrantEnum.OWNER } }),
    ]) {
      rerender(options({ page: specified }));
      await act(async () => {
        await result.current.requestChange(PageGrantEnum.PUBLIC);
      });
      expect(result.current.confirmation).not.toBeNull();
      rerender(changed);
      expect(result.current.confirmation).toBeNull();
    }
  });
});
