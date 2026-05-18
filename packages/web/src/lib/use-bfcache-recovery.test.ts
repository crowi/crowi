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

describe('useBfcacheRecovery', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('re-runs the auth check on a bfcache restore (pageshow persisted)', () => {
    const recheckAuth = vi.fn();
    const { wrapper } = makeContext();
    renderHook(() => useBfcacheRecovery(recheckAuth), { wrapper });

    firePageShow(true);

    expect(recheckAuth).toHaveBeenCalledTimes(1);
  });

  it('invalidates active queries on a bfcache restore', () => {
    const recheckAuth = vi.fn();
    const { client, wrapper } = makeContext();
    const invalidateSpy = vi.spyOn(client, 'invalidateQueries');
    renderHook(() => useBfcacheRecovery(recheckAuth), { wrapper });

    firePageShow(true);

    expect(invalidateSpy).toHaveBeenCalledWith({ type: 'active' });
  });

  it('ignores a normal pageshow (persisted = false)', () => {
    const recheckAuth = vi.fn();
    const { client, wrapper } = makeContext();
    const invalidateSpy = vi.spyOn(client, 'invalidateQueries');
    renderHook(() => useBfcacheRecovery(recheckAuth), { wrapper });

    firePageShow(false);

    expect(recheckAuth).not.toHaveBeenCalled();
    expect(invalidateSpy).not.toHaveBeenCalled();
  });

  it('removes the listener on unmount', () => {
    const recheckAuth = vi.fn();
    const { wrapper } = makeContext();
    const { unmount } = renderHook(() => useBfcacheRecovery(recheckAuth), { wrapper });

    unmount();
    firePageShow(true);

    expect(recheckAuth).not.toHaveBeenCalled();
  });
});
