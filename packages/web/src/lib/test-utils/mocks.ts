/**
 * Shared mock factories for web unit tests.
 *
 * Design notes:
 * - `vi.mock(path, factory)` declarations must remain in each test file
 *   (Vitest hoists them; they cannot be generated dynamically).  The
 *   functions here produce the *module-shape object* that each factory
 *   returns, so shape stays consistent across test files without the
 *   vi.fn() stubs leaking.
 * - vi.fn() stubs that tests must control (mockReturnValue in beforeEach)
 *   are still created with vi.hoisted() inside each test file.  The
 *   factories below just enforce the uniform module shape.
 */

import type { Mock } from 'vitest';

// ---------------------------------------------------------------------------
// next/navigation
// ---------------------------------------------------------------------------

/**
 * Uniform module shape for `vi.mock('next/navigation', ...)`.
 *
 * Before this factory, page-header.test.tsx only stubbed `push`, while
 * edit-page-client.test.tsx and session-reauth-context.test.tsx also
 * provided `replace` and `back`.  All call sites now use this function
 * so the shape is consistent.
 *
 * Usage (each test file keeps its own vi.mock declaration):
 *
 *   const { push, replace, back } = vi.hoisted(() => ({
 *     push: vi.fn(), replace: vi.fn(), back: vi.fn(),
 *   }));
 *   vi.mock('next/navigation', () =>
 *     nextNavigationMockModule({ push, replace, back }),
 *   );
 */
export function nextNavigationMockModule(fns: { push: Mock; replace?: Mock; back?: Mock; searchParamsGet?: Mock }) {
  return {
    useRouter: () => ({
      push: fns.push,
      replace: fns.replace ?? (() => {}),
      back: fns.back ?? (() => {}),
    }),
    ...(fns.searchParamsGet !== undefined ? { useSearchParams: () => ({ get: fns.searchParamsGet }) } : {}),
  };
}

// ---------------------------------------------------------------------------
// @/lib/use-auth
// ---------------------------------------------------------------------------

/**
 * Module shape for `vi.mock('@/lib/use-auth', ...)`.
 *
 * Pass the vi.fn() stub created with vi.hoisted() so tests can call
 * `useAuth.mockReturnValue(...)` in beforeEach.
 *
 * Usage:
 *   const { useAuth } = vi.hoisted(() => ({ useAuth: vi.fn() }));
 *   vi.mock('@/lib/use-auth', () => useAuthMockModule(useAuth));
 */
export function useAuthMockModule(useAuthFn: Mock) {
  return { useAuth: useAuthFn };
}

// ---------------------------------------------------------------------------
// window.matchMedia
// ---------------------------------------------------------------------------

/**
 * Build a `window.matchMedia` implementation whose `matches` is decided by
 * `isMatch`.
 *
 * The global jsdom stub in `vitest.setup.ts` reports "no match" for every
 * query; a test that needs a specific query to match spies over it with
 * this instead of hand-rolling the `MediaQueryList` literal:
 *
 *   vi.spyOn(window, 'matchMedia').mockImplementation(
 *     matchMediaImpl((query) => query === WIDE_VIEWPORT_QUERY),
 *   );
 *
 * (The `vi.spyOn` itself stays in the test file so this module keeps its
 * vitest import type-only.)
 */
export function matchMediaImpl(isMatch: (query: string) => boolean): (query: string) => MediaQueryList {
  return (query: string) =>
    ({
      matches: isMatch(query),
      media: query,
      onchange: null,
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false,
    }) as unknown as MediaQueryList;
}

// ---------------------------------------------------------------------------
// API response helper
// ---------------------------------------------------------------------------

/**
 * Build a `Response`-shaped object matching what `apiClientV2` (a
 * `createClient` typed client) returns.
 *
 * This replaces the local `makeResponse` / `tokenOkResponse` / `okResponse` /
 * `errorResponse` helpers that appeared identically in:
 *   - inline-attachment-link.test.tsx
 *   - CollaborativeMarkdownEditor.test.tsx
 *   - use-drafts.test.ts
 *   - use-notifications-socket.test.tsx
 *   - use-yjs-token.test.ts
 *   - use-attachments.test.ts
 *   - use-presence.test.ts
 *
 * Usage:
 *   metaGet.mockResolvedValue(makeApiResponse(200, makeMeta()));
 *   getYjsToken.mockResolvedValue(makeApiResponse(200, token));
 */
export function makeApiResponse<T>(status: number, body: T): { ok: boolean; status: number; json: () => Promise<T> } {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(body),
  };
}
