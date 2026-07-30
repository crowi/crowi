import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import type { PropsWithChildren } from 'react';
import { createElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Mock `apiClient` (`createClient`) at the module level so the hook
// reads our fake `pages.preview.$post`. Vitest hoists `vi.mock` above
// imports; `vi.hoisted` makes the shared stub reachable from both the
// factory and the test bodies without a TDZ violation.
const { previewPost } = vi.hoisted(() => ({ previewPost: vi.fn() }));
vi.mock('./api-client', () => ({
  apiClient: { pages: { preview: { $post: previewPost } } },
}));

import { usePreview } from './use-preview';

/** Build a `Response`-shaped object matching what `hc` returns. */
const makeResponse = (renderedAst: unknown): { ok: boolean; status: number; json: () => Promise<{ renderedAst: unknown }> } => ({
  ok: true,
  status: 200,
  json: async () => ({ renderedAst }),
});

function makeWrapper() {
  // Fresh QueryClient per test so mutation state doesn't leak across cases.
  const client = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
  const wrapper = ({ children }: PropsWithChildren) => createElement(QueryClientProvider, { client }, children);
  return wrapper;
}

beforeEach(() => {
  previewPost.mockReset();
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

/**
 * feature-plugin-renderer-mermaid spec §7 item 8 — `usePreview`'s
 * `AbortController` wiring: every call aborts whichever previous call is
 * still in flight, and always passes a fresh, non-aborted signal on the
 * request it is about to make.
 */
describe('usePreview — AbortController wiring (spec §7 item 8)', () => {
  it('passes { init: { signal } } on every call, with a fresh, non-aborted AbortSignal', async () => {
    previewPost.mockResolvedValue(makeResponse({ type: 'root', children: [] }));
    const { result } = renderHook(() => usePreview(), { wrapper: makeWrapper() });

    await act(async () => {
      await result.current.mutateAsync('# hello');
    });

    expect(previewPost).toHaveBeenCalledTimes(1);
    const [json, options] = previewPost.mock.calls[0];
    expect(json).toEqual({ json: { body: '# hello' } });
    expect(options?.init?.signal).toBeInstanceOf(AbortSignal);
    expect(options.init.signal.aborted).toBe(false);
  });

  it('aborts the previous in-flight request when a new preview call starts before the first settles', async () => {
    let firstOptions: { init?: { signal?: AbortSignal } } | undefined;
    previewPost.mockImplementationOnce((_json: unknown, options: { init?: { signal?: AbortSignal } }) => {
      firstOptions = options;
      return new Promise(() => {}); // never resolves in this test
    });
    previewPost.mockResolvedValueOnce(makeResponse({ type: 'root', children: [] }));

    const { result } = renderHook(() => usePreview(), { wrapper: makeWrapper() });

    act(() => {
      result.current.mutate('first');
    });
    await waitFor(() => expect(firstOptions).toBeDefined());
    expect(firstOptions?.init?.signal?.aborted).toBe(false);

    act(() => {
      result.current.mutate('second');
    });

    await waitFor(() => expect(firstOptions?.init?.signal?.aborted).toBe(true));
    expect(previewPost).toHaveBeenCalledTimes(2);
    // The second call's own signal is a DIFFERENT, non-aborted controller.
    const [, secondOptions] = previewPost.mock.calls[1];
    expect(secondOptions?.init?.signal).not.toBe(firstOptions?.init?.signal);
    expect(secondOptions?.init?.signal?.aborted).toBe(false);
  });

  it('throws "Failed to render preview" when the response is not ok', async () => {
    previewPost.mockResolvedValue({ ok: false, status: 500, json: async () => ({}) });
    const { result } = renderHook(() => usePreview(), { wrapper: makeWrapper() });

    await act(async () => {
      await expect(result.current.mutateAsync('# hello')).rejects.toThrow('Failed to render preview');
    });
  });
});
