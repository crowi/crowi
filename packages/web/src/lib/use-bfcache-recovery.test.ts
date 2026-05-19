import { describe, it, expect, beforeEach, vi } from 'vitest';
import { renderHook } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { PropsWithChildren } from 'react';
import { createElement } from 'react';

import { useBfcacheRecovery } from './use-bfcache-recovery';

function makeContext() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  const wrapper = ({ children }: PropsWithChildren) => createElement(QueryClientProvider, { client }, children);
  return { client, wrapper };
}

/** Dispatch a `pageshow` event; `persisted` marks a bfcache restore. */
function firePageShow(persisted: boolean) {
  const event = new Event('pageshow') as Event & { persisted: boolean };
  Object.defineProperty(event, 'persisted', { value: persisted });
  window.dispatchEvent(event);
}

/** Let the async `pageshow` handler's awaited query work settle. */
function flushMicrotasks() {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

describe('useBfcacheRecovery', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('skips the initial-load pageshow (first pageshow is not a restore)', () => {
    const recheckAuth = vi.fn();
    const { client, wrapper } = makeContext();
    const cancelSpy = vi.spyOn(client, 'cancelQueries');
    renderHook(() => useBfcacheRecovery(recheckAuth), { wrapper });

    // The first pageshow after a fresh load is the initial load.
    firePageShow(false);

    expect(recheckAuth).not.toHaveBeenCalled();
    expect(cancelSpy).not.toHaveBeenCalled();
  });

  it('re-runs the auth check on a bfcache restore (pageshow persisted)', () => {
    const recheckAuth = vi.fn();
    const { wrapper } = makeContext();
    renderHook(() => useBfcacheRecovery(recheckAuth), { wrapper });

    firePageShow(false); // initial load
    firePageShow(true); // bfcache restore

    expect(recheckAuth).toHaveBeenCalledTimes(1);
  });

  it('also recovers on a non-bfcache restore (persisted = false reload)', () => {
    const recheckAuth = vi.fn();
    const { wrapper } = makeContext();
    renderHook(() => useBfcacheRecovery(recheckAuth), { wrapper });

    firePageShow(false); // initial load
    firePageShow(false); // Back reload — the page was evicted from bfcache

    expect(recheckAuth).toHaveBeenCalledTimes(1);
  });

  it('cancels then refetches active queries on a restore', async () => {
    const recheckAuth = vi.fn();
    const { client, wrapper } = makeContext();
    const cancelSpy = vi.spyOn(client, 'cancelQueries');
    const refetchSpy = vi.spyOn(client, 'refetchQueries');
    renderHook(() => useBfcacheRecovery(recheckAuth), { wrapper });

    firePageShow(false); // initial load
    firePageShow(true); // restore
    await flushMicrotasks();

    // cancelQueries must run first so refetchQueries is not deduped
    // against a frozen in-flight request.
    expect(cancelSpy).toHaveBeenCalledWith({ type: 'active' });
    expect(refetchSpy).toHaveBeenCalledWith({ type: 'active' });
    expect(cancelSpy.mock.invocationCallOrder[0]).toBeLessThan(refetchSpy.mock.invocationCallOrder[0]);
  });

  it('removes the listener on unmount', () => {
    const recheckAuth = vi.fn();
    const { wrapper } = makeContext();
    const { unmount } = renderHook(() => useBfcacheRecovery(recheckAuth), { wrapper });

    firePageShow(false); // initial load
    unmount();
    firePageShow(true);

    expect(recheckAuth).not.toHaveBeenCalled();
  });
});
