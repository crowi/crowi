import { beforeEach, describe, expect, it, vi } from 'vitest';

// Same runtime-env mock the sibling api-client.test.ts uses — the client
// resolves its origin at call time.
const envMock = vi.fn<(key: string) => string | undefined>();
vi.mock('./runtime-env', () => ({ env: (key: string) => envMock(key) }));

import { apiClientV2 } from './api-client';

/**
 * RFC-0023 §9 — the web is a PERMANENT declaration-less client: no
 * request built through `apiClientV2` / `apiV2Fetch` may ever carry
 * `X-Crowi-Ast-Version` (the closed v1 registry would opaque-ise
 * third-party plugin nodes the legacy branch renders fine today).
 */
describe('apiV2Fetch never sends X-Crowi-Ast-Version (RFC-0023 §9)', () => {
  beforeEach(() => {
    envMock.mockReturnValue(undefined);
    localStorage.clear();
  });

  it('a renderedAst-consuming call (getPage / preview) carries no AST version header', async () => {
    const seen: Headers[] = [];
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      seen.push(new Headers(init?.headers));
      return new Response(JSON.stringify({}), { status: 200, headers: { 'Content-Type': 'application/json' } });
    });
    vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch);
    try {
      await apiClientV2.pages.$get({ query: { path: '/x' } });
      await apiClientV2.pages.preview.$post({ json: { body: '# x' } });
    } finally {
      vi.unstubAllGlobals();
    }
    expect(seen.length).toBeGreaterThanOrEqual(2);
    for (const headers of seen) {
      expect(headers.has('x-crowi-ast-version')).toBe(false);
    }
  });
});
