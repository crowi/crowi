import { beforeEach, describe, expect, it, vi } from 'vitest';

// Same trick as api-client.test.ts: `env()` is the runtime reader, mocked so a
// single test can change what `NEXT_PUBLIC_API_URL` resolves to between calls.
const envMock = vi.fn<(key: string) => string | undefined>();
vi.mock('./runtime-env', () => ({ env: (key: string) => envMock(key) }));

import { MCP_ENDPOINT_PLACEHOLDER, resolveMcpEndpoint } from './resolve-mcp-endpoint';

describe('resolveMcpEndpoint', () => {
  beforeEach(() => {
    envMock.mockReset();
  });

  it('derives the endpoint from the browser origin when no api URL is baked in', () => {
    envMock.mockReturnValue(undefined);
    // jsdom's default location; the front proxy forwards /api/* to the api.
    expect(resolveMcpEndpoint()).toBe(`${window.location.origin}/api/mcp`);
  });

  it('prefers a cross-origin NEXT_PUBLIC_API_URL over the browser origin', () => {
    envMock.mockReturnValue('https://api.example.com');
    expect(resolveMcpEndpoint()).toBe('https://api.example.com/api/mcp');
  });

  it('strips a trailing slash so the endpoint is never `…//api/mcp`', () => {
    envMock.mockReturnValue('https://api.example.com/');
    expect(resolveMcpEndpoint()).toBe('https://api.example.com/api/mcp');
  });

  it('falls back to the placeholder when there is no origin to read (SSR)', () => {
    envMock.mockReturnValue(undefined);
    vi.stubGlobal('window', undefined);
    expect(resolveMcpEndpoint()).toBe(MCP_ENDPOINT_PLACEHOLDER);
  });
});
