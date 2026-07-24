import { beforeEach, describe, expect, it, vi } from 'vitest';

// `env()` is the next-runtime-env runtime reader. Mock it so the test can
// change its return value *between calls* — that is exactly what distinguishes
// a runtime read (correct) from a module-scope freeze (the bug this guards).
const envMock = vi.fn<(key: string) => string | undefined>();
vi.mock('./runtime-env', () => ({ env: (key: string) => envMock(key) }));

import { apiOrigin, apiV2BaseUrl, resolveApiUrl } from './api-client';

describe('api base resolution', () => {
  beforeEach(() => {
    envMock.mockReset();
  });

  it('defaults to same-origin (relative) when NEXT_PUBLIC_API_URL is unset', () => {
    envMock.mockReturnValue(undefined);
    expect(apiOrigin()).toBe('');
    expect(apiV2BaseUrl()).toBe('/api/v2');
  });

  it('reads NEXT_PUBLIC_API_URL at call time, not at module load (cross-origin)', () => {
    // Simulate the real timing: the module evaluated while window.__ENV was
    // still empty (env() -> undefined), then PublicEnvScript populated it. A
    // module-scope `const API_BASE_URL = env(...)` would stay '' forever; the
    // call-time read must reflect the now-injected cross-origin origin.
    envMock.mockReturnValue(undefined);
    expect(apiV2BaseUrl()).toBe('/api/v2');

    envMock.mockReturnValue('https://api.example.com');
    expect(apiOrigin()).toBe('https://api.example.com');
    expect(apiV2BaseUrl()).toBe('https://api.example.com/api/v2');
  });

  it('strips a trailing slash so the base is never `…//api/v2`', () => {
    envMock.mockReturnValue('https://api.example.com/');
    expect(apiOrigin()).toBe('https://api.example.com');
    expect(apiV2BaseUrl()).toBe('https://api.example.com/api/v2');
  });
});

/**
 * `resolveApiUrl` — shared by `apiV2Fetch` (request URLs) and
 * `RendererStylesheets` (`<link href>` values, feature-renderer-plugin-
 * boundary Phase 1). Same call-time-read + relative-when-empty-origin rule
 * as `apiOrigin`/`apiV2BaseUrl` above, exercised directly here instead of
 * only indirectly through a fetch call.
 */
describe('resolveApiUrl', () => {
  beforeEach(() => {
    envMock.mockReset();
  });

  it('returns the path unchanged (relative) when NEXT_PUBLIC_API_URL is unset', () => {
    envMock.mockReturnValue(undefined);
    expect(resolveApiUrl('/api/v2/plugins/@crowi/plugin-renderer-katex/katex.css')).toBe('/api/v2/plugins/@crowi/plugin-renderer-katex/katex.css');
  });

  it('prepends the runtime API origin, read at call time', () => {
    envMock.mockReturnValue(undefined);
    expect(resolveApiUrl('/api/v2/app/info')).toBe('/api/v2/app/info');

    envMock.mockReturnValue('https://api.example.com');
    expect(resolveApiUrl('/api/v2/app/info')).toBe('https://api.example.com/api/v2/app/info');
  });
});
