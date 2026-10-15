import { act, cleanup, renderHook } from '@testing-library/react';
import { StrictMode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { infoGet, apiOriginRef } = vi.hoisted(() => ({ infoGet: vi.fn(), apiOriginRef: { value: '' } }));
vi.mock('./api-client', () => ({
  apiClient: { app: { info: { $get: infoGet } } },
  resolveApiUrl: (path: string) => (apiOriginRef.value ? `${apiOriginRef.value}${path}` : path),
}));

import { fetchHtmlSanitizationPolicy, resolveHtmlSanitizationPolicy, useHtmlSanitizationPolicy } from './use-html-sanitization-policy';

const ok = (body: unknown) => ({ ok: true, status: 200, json: async () => body });
const info = (htmlSanitizationEnabled: unknown, artifactDelivery: unknown = { enabled: false, origin: null }) =>
  ok({ htmlSanitizationEnabled, artifactDelivery });

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const flush = () => act(async () => {});

beforeEach(() => {
  infoGet.mockReset();
  apiOriginRef.value = '';
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('resolveHtmlSanitizationPolicy', () => {
  it('relaxes only on a boolean false', () => {
    expect(resolveHtmlSanitizationPolicy(false)).toBe('relaxed');
    for (const value of [true, undefined, null, 'false', 0, {}]) expect(resolveHtmlSanitizationPolicy(value)).toBe('strict');
  });
});

describe('snapshot-fail-closed', () => {
  it('is strict on the first render and when never fetched (inactive)', async () => {
    const { result } = renderHook(() => useHtmlSanitizationPolicy('a', false));
    await flush();
    expect(result.current).toEqual({ policy: 'strict' });
    expect(infoGet).not.toHaveBeenCalled();
  });

  it('relaxes on an explicit false and carries the origins of the same response', async () => {
    infoGet.mockResolvedValue(info(false, { enabled: true, origin: 'https://artifacts.example.net/' }));
    const { result } = renderHook(() => useHtmlSanitizationPolicy('a'));
    expect(result.current).toEqual({ policy: 'strict' });
    await flush();
    expect(result.current.policy).toBe('relaxed');
    expect(result.current.iframeOrigins).toEqual({
      webOrigin: window.location.origin,
      apiOrigin: window.location.origin,
      artifactOrigin: 'https://artifacts.example.net',
    });
    expect(infoGet).toHaveBeenCalledWith({}, expect.objectContaining({ init: expect.objectContaining({ cache: 'no-store' }) }));
  });

  it.each([[true], [undefined], [null], ['false'], [0]])('stays strict for %p', async (value) => {
    infoGet.mockResolvedValue(info(value));
    const { result } = renderHook(() => useHtmlSanitizationPolicy('a'));
    await flush();
    expect(result.current).toEqual({ policy: 'strict' });
  });

  it('stays strict on a failed status, a thrown request and broken JSON', async () => {
    for (const failure of [
      () => Promise.resolve({ ok: false, status: 500, json: async () => ({ htmlSanitizationEnabled: false }) }),
      () => Promise.reject(new Error('network')),
      () => Promise.resolve({ ok: true, status: 200, json: async () => Promise.reject(new SyntaxError('bad')) }),
    ]) {
      infoGet.mockImplementationOnce(failure);
      const { result, unmount } = renderHook(() => useHtmlSanitizationPolicy('a'));
      await flush();
      expect(result.current).toEqual({ policy: 'strict' });
      unmount();
    }
  });

  it('settles strict at the deadline when the JSON body stalls after the headers arrive', async () => {
    vi.useFakeTimers();
    let signal: AbortSignal | undefined;
    infoGet.mockImplementation((_args: unknown, options: { init: { signal: AbortSignal } }) => {
      signal = options.init.signal;
      return Promise.resolve({ ok: true, status: 200, json: () => new Promise(() => {}) });
    });
    const { result } = renderHook(() => useHtmlSanitizationPolicy('a'));
    await act(async () => {});
    expect(result.current.policy).toBe('strict');
    await act(async () => {
      await vi.advanceTimersByTimeAsync(20_001);
    });
    expect(signal?.aborted).toBe(true);
    expect(result.current).toEqual({ policy: 'strict' });

    // The standalone fetch also rejects instead of hanging when the request ignores abort.
    infoGet.mockImplementation(() => new Promise(() => {}));
    const pending = fetchHtmlSanitizationPolicy(new AbortController().signal);
    const outcome = pending.then(
      () => 'resolved',
      (error: Error) => error.message,
    );
    await vi.advanceTimersByTimeAsync(20_001);
    await expect(outcome).resolves.toBe('timeout');
  });

  it('does not reuse a stale relaxed value after the deadline-driven strict', async () => {
    vi.useFakeTimers();
    const late = deferred<ReturnType<typeof info>>();
    infoGet.mockReturnValue(late.promise);
    const { result } = renderHook(() => useHtmlSanitizationPolicy('a'));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(20_001);
    });
    late.resolve(info(false));
    await act(async () => {});
    expect(result.current.policy).toBe('strict');
  });
});

describe('generation-races', () => {
  it('returns strict in the very render that sees a new view key, and ignores a late response of the old view', async () => {
    const first = deferred<ReturnType<typeof info>>();
    infoGet.mockReturnValueOnce(first.promise);
    const seen: string[] = [];
    const { result, rerender } = renderHook(
      ({ k }) => {
        const snapshot = useHtmlSanitizationPolicy(k);
        seen.push(`${k}:${snapshot.policy}`);
        return snapshot;
      },
      { initialProps: { k: 'a' } },
    );

    infoGet.mockResolvedValueOnce(info(true));
    rerender({ k: 'b' });
    await flush();
    first.resolve(info(false));
    await flush();
    expect(result.current.policy).toBe('strict');
    expect(seen.filter((s) => s.startsWith('b:'))).toEqual(expect.arrayContaining(['b:strict']));
    expect(seen).not.toContain('b:relaxed');
  });

  it('A -> B -> A never shows the first A relaxed value on the return', async () => {
    infoGet.mockResolvedValueOnce(info(false));
    const { result, rerender } = renderHook(({ k }) => useHtmlSanitizationPolicy(k), { initialProps: { k: 'a' } });
    await flush();
    expect(result.current.policy).toBe('relaxed');

    const second = deferred<ReturnType<typeof info>>();
    infoGet.mockReturnValueOnce(second.promise);
    rerender({ k: 'b' });
    expect(result.current.policy).toBe('strict');

    const third = deferred<ReturnType<typeof info>>();
    infoGet.mockReturnValueOnce(third.promise);
    rerender({ k: 'a' });
    expect(result.current.policy).toBe('strict');
    expect(infoGet).toHaveBeenCalledTimes(3);
    second.resolve(info(false));
    await flush();
    expect(result.current.policy).toBe('strict');
    third.resolve(info(false));
    await flush();
    expect(result.current.policy).toBe('relaxed');
  });

  it('aborts the request on unmount', async () => {
    let signal: AbortSignal | undefined;
    infoGet.mockImplementation((_args: unknown, options: { init: { signal: AbortSignal } }) => {
      signal = options.init.signal;
      return new Promise(() => {});
    });
    const { unmount } = renderHook(() => useHtmlSanitizationPolicy('a'));
    await flush();
    unmount();
    expect(signal?.aborted).toBe(true);
  });

  it('fetches once when it first becomes active and not again on later active flips or re-renders', async () => {
    infoGet.mockResolvedValue(info(false));
    const { result, rerender } = renderHook(({ active }) => useHtmlSanitizationPolicy('a', active), { initialProps: { active: false } });
    await flush();
    expect(infoGet).not.toHaveBeenCalled();
    rerender({ active: true });
    await flush();
    expect(infoGet).toHaveBeenCalledTimes(1);
    expect(result.current.policy).toBe('relaxed');
    rerender({ active: false });
    rerender({ active: true });
    window.dispatchEvent(new Event('focus'));
    await flush();
    expect(infoGet).toHaveBeenCalledTimes(1);
    expect(result.current.policy).toBe('relaxed');
  });

  it('still succeeds after the StrictMode effect re-run', async () => {
    infoGet.mockResolvedValue(info(false));
    const { result } = renderHook(() => useHtmlSanitizationPolicy('a'), { wrapper: StrictMode });
    await flush();
    expect(result.current.policy).toBe('relaxed');
  });

  it('returns to strict on a persisted pagehide and refetches on the persisted pageshow', async () => {
    infoGet.mockResolvedValueOnce(info(false));
    const { result } = renderHook(() => useHtmlSanitizationPolicy('a'));
    await flush();
    expect(result.current.policy).toBe('relaxed');

    act(() => {
      window.dispatchEvent(Object.assign(new Event('pagehide'), { persisted: true }));
    });
    expect(result.current).toEqual({ policy: 'strict' });
    expect(infoGet).toHaveBeenCalledTimes(1);

    infoGet.mockResolvedValueOnce(info(true));
    act(() => {
      window.dispatchEvent(Object.assign(new Event('pageshow'), { persisted: true }));
    });
    await flush();
    expect(infoGet).toHaveBeenCalledTimes(2);
    expect(result.current.policy).toBe('strict');
  });

  it('ignores a non-persisted pagehide / pageshow', async () => {
    infoGet.mockResolvedValue(info(false));
    const { result } = renderHook(() => useHtmlSanitizationPolicy('a'));
    await flush();
    act(() => {
      window.dispatchEvent(Object.assign(new Event('pagehide'), { persisted: false }));
      window.dispatchEvent(Object.assign(new Event('pageshow'), { persisted: false }));
    });
    await flush();
    expect(result.current.policy).toBe('relaxed');
    expect(infoGet).toHaveBeenCalledTimes(1);
  });
});

describe('iframe origins', () => {
  const originsFor = async (artifactDelivery: unknown) => {
    infoGet.mockResolvedValueOnce(info(false, artifactDelivery));
    const { result, unmount } = renderHook(() => useHtmlSanitizationPolicy('a'));
    await flush();
    const snapshot = result.current;
    unmount();
    return snapshot;
  };

  it('uses the runtime api origin and excludes an artifact origin even when delivery is disabled', async () => {
    apiOriginRef.value = 'https://api.example.org';
    const snapshot = await originsFor({ enabled: false, origin: 'https://artifacts.example.net' });
    expect(snapshot.iframeOrigins).toEqual({
      webOrigin: window.location.origin,
      apiOrigin: 'https://api.example.org',
      artifactOrigin: 'https://artifacts.example.net',
    });
  });

  it('accepts disabled delivery without an origin', async () => {
    const snapshot = await originsFor({ enabled: false, origin: null });
    expect(snapshot.iframeOrigins?.artifactOrigin).toBeNull();
  });

  it.each([
    [{ enabled: true, origin: null }],
    [null],
    [{ enabled: 'yes', origin: null }],
    [{ enabled: false, origin: 5 }],
    [{ enabled: true, origin: 'not a url' }],
    [{ enabled: true, origin: 'ftp://x.example' }],
  ])('relaxes without iframeOrigins for %j (iframes stay rejected)', async (delivery) => {
    const snapshot = await originsFor(delivery);
    expect(snapshot.policy).toBe('relaxed');
    expect(snapshot.iframeOrigins).toBeUndefined();
  });

  it('rejects iframes when artifactDelivery is absent from the response', async () => {
    infoGet.mockResolvedValueOnce(ok({ htmlSanitizationEnabled: false }));
    const { result } = renderHook(() => useHtmlSanitizationPolicy('a'));
    await flush();
    expect(result.current).toEqual({ policy: 'relaxed' });
  });

  it('does not bring back the origins of an old generation', async () => {
    infoGet.mockResolvedValueOnce(info(false, { enabled: true, origin: 'https://artifacts.example.net' }));
    const { result, rerender } = renderHook(({ k }) => useHtmlSanitizationPolicy(k), { initialProps: { k: 'a' } });
    await flush();
    expect(result.current.iframeOrigins).toBeDefined();
    infoGet.mockReturnValueOnce(new Promise(() => {}));
    rerender({ k: 'b' });
    expect(result.current).toEqual({ policy: 'strict' });
  });
});
