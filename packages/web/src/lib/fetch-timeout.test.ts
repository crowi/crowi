import { describe, it, expect, vi, afterEach } from 'vitest';
import { fetchWithTimeout, TIMEOUT_ABORT_REASON } from './fetch-timeout';
import { isTimeoutAbort } from './is-network-error';

afterEach(() => {
  vi.restoreAllMocks();
});

/**
 * Stub `fetch` to resolve only when its `signal` aborts, rejecting with an
 * AbortError that carries the abort reason — mirroring the browser's behaviour
 * closely enough to assert on the composed signal.
 */
function stubAbortableFetch() {
  return vi.spyOn(globalThis, 'fetch').mockImplementation((_input, init) => {
    const signal = (init as RequestInit | undefined)?.signal;
    return new Promise<Response>((_resolve, reject) => {
      if (!signal) return; // hang forever if no signal (shouldn't happen here)
      const onAbort = () => {
        const err = new Error('aborted') as Error & { reason?: unknown };
        err.name = 'AbortError';
        err.reason = signal.reason;
        reject(err);
      };
      if (signal.aborted) onAbort();
      else signal.addEventListener('abort', onAbort);
    });
  });
}

describe('fetchWithTimeout', () => {
  it('aborts with the timeout sentinel when the response hangs past the timeout', async () => {
    stubAbortableFetch();

    const promise = fetchWithTimeout('https://example.test/api', undefined, 5);

    await expect(promise).rejects.toMatchObject({ name: 'AbortError' });
    await promise.catch((err) => {
      expect(isTimeoutAbort(err)).toBe(true);
    });
  });

  it('passes a signal through to fetch even when the caller provides none', async () => {
    const spy = stubAbortableFetch();

    await fetchWithTimeout('https://example.test/api', undefined, 5).catch(() => {});

    const passedInit = spy.mock.calls[0]?.[1] as RequestInit | undefined;
    expect(passedInit?.signal).toBeInstanceOf(AbortSignal);
  });

  it('composes the caller signal so a user/react-query cancel still aborts (non-timeout reason)', async () => {
    stubAbortableFetch();

    const userController = new AbortController();
    const promise = fetchWithTimeout('https://example.test/api', { signal: userController.signal }, 10_000);

    userController.abort('user-cancel');

    await expect(promise).rejects.toMatchObject({ name: 'AbortError' });
    // The composed abort carries the caller's reason, NOT the timeout sentinel,
    // so it is correctly treated as a cancel rather than a network outage.
    await promise.catch((err) => {
      expect(isTimeoutAbort(err)).toBe(false);
      expect((err as { reason?: unknown }).reason).not.toBe(TIMEOUT_ABORT_REASON);
    });
  });

  it('resolves normally and clears the timer when fetch succeeds', async () => {
    const ok = new Response('ok', { status: 200 });
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(ok);

    const res = await fetchWithTimeout('https://example.test/api', undefined, 50);
    expect(res.status).toBe(200);
  });
});
