import { beforeEach, describe, expect, it, vi } from 'vitest';

// feature-access-token-cookie-path-scope AC-5 — `auth-token.ts` must never
// consult the split-origin runtime env when writing the mirror cookie (that
// would require a Domain attribute to reach a cross-origin API host, which
// this feature explicitly does not add). Mocking `./runtime-env` lets the
// "no Domain, even split-origin" test below flip the configured API origin
// without touching real `window.__ENV`.
const envMock = vi.fn<(key: string) => string | undefined>();
vi.mock('./runtime-env', () => ({ env: (key: string) => envMock(key) }));

import { clearTokens, storeTokens } from './auth-token';

/** One captured `document.cookie = "..."` assignment. */
type CookieAttrs = Record<string, string>;

function parseCookieWrite(write: string): CookieAttrs {
  const [nameValue, ...attrParts] = write.split(';').map((part) => part.trim());
  const eq = nameValue.indexOf('=');
  const attrs: CookieAttrs = { name: nameValue.slice(0, eq), value: nameValue.slice(eq + 1) };
  for (const attrPart of attrParts) {
    const [key, value] = attrPart.split('=');
    attrs[key.toLowerCase()] = value ?? 'true';
  }
  return attrs;
}

/**
 * RFC 6265 §5.1.4 path-match — the exact algorithm a browser uses to decide
 * whether a cookie's `path` attribute covers a given request path. Kept
 * local to this test file (not exported by `auth-token.ts`, which keeps
 * `ACCESS_TOKEN_COOKIE_PATH` module-private per the design) so the AC-3
 * table test below exercises real cookie matching semantics instead of a
 * naive `startsWith` check that would pass for `/api/attachments-meta` too.
 */
function cookiePathMatches(cookiePath: string, requestPath: string): boolean {
  if (requestPath === cookiePath) return true;
  if (!requestPath.startsWith(cookiePath)) return false;
  if (cookiePath.endsWith('/')) return true;
  return requestPath[cookiePath.length] === '/';
}

/** Every `document.cookie = "..."` assignment made during the current test, oldest first. */
let writes: string[];

beforeEach(() => {
  writes = [];
  localStorage.clear();
  envMock.mockReset();
  envMock.mockReturnValue(undefined);
  // jsdom's own `document.cookie` accessor applies real cookie-jar semantics
  // (path-matched reads, `Path`/`Domain` validation, ...) scoped to jsdom's
  // fixed document URL — none of which reflects what a real browser would do
  // for a Path this test's document isn't actually served under. Replacing
  // the accessor with a plain recorder observes exactly what `auth-token.ts`
  // asks the browser to do, which is what AC-1/AC-2/AC-3 care about.
  Object.defineProperty(document, 'cookie', {
    configurable: true,
    get: () => '',
    set: (value: string) => {
      writes.push(value);
    },
  });
});

describe('auth token cookie persistence', () => {
  it('storeTokens writes the scoped cookie at /api/attachments with the caller TTL and SameSite=Lax (AC-1)', () => {
    storeTokens({ accessToken: 'tok-1' }, 900);

    const scopedWrite = writes.find((write) => write.includes('max-age=900'));
    expect(scopedWrite).toBeDefined();
    const attrs = parseCookieWrite(scopedWrite as string);
    expect(attrs.name).toBe('crowi.accessToken');
    expect(decodeURIComponent(attrs.value)).toBe('tok-1');
    expect(attrs.path).toBe('/api/attachments');
    expect(attrs['max-age']).toBe('900');
    expect(attrs.samesite).toBe('lax');
  });

  it('clearTokens deletes the cookie via the same scoped path storeTokens wrote (AC-1)', () => {
    storeTokens({ accessToken: 'tok-1' }, 900);
    const setPath = parseCookieWrite(writes.find((write) => write.includes('max-age=900')) as string).path;

    writes = [];
    clearTokens();

    const scopedDelete = writes.find((write) => write.includes('max-age=0') && write.includes('path=/api/attachments'));
    expect(scopedDelete).toBeDefined();
    expect(parseCookieWrite(scopedDelete as string).path).toBe(setPath);
  });

  it('storeTokens expires a pre-existing path=/ cookie before writing the scoped cookie (AC-2)', () => {
    storeTokens({ accessToken: 'tok-1' }, 900);

    const rootDeleteIndex = writes.findIndex((write) => write.includes('path=/;') && write.includes('max-age=0'));
    const scopedSetIndex = writes.findIndex((write) => write.includes('path=/api/attachments') && write.includes('max-age=900'));
    expect(rootDeleteIndex).toBeGreaterThanOrEqual(0);
    expect(scopedSetIndex).toBeGreaterThanOrEqual(0);
    expect(rootDeleteIndex).toBeLessThan(scopedSetIndex);
  });

  it('clearTokens expires both the scoped cookie and the legacy root cookie (AC-2)', () => {
    clearTokens();

    expect(writes.some((write) => write.includes('path=/api/attachments') && write.includes('max-age=0'))).toBe(true);
    expect(writes.some((write) => write.includes('path=/;') && write.includes('max-age=0'))).toBe(true);
  });

  it('repeated store/clear cycles keep re-issuing the legacy root delete idempotently (AC-2)', () => {
    // First cycle: login, then logout.
    storeTokens({ accessToken: 'tok-1' }, 900);
    clearTokens();

    // Second cycle, as if the (already-cleaned-up) legacy cookie never existed.
    writes = [];
    storeTokens({ accessToken: 'tok-2' }, 900);
    expect(writes.some((write) => write.includes('path=/;') && write.includes('max-age=0'))).toBe(true);

    writes = [];
    clearTokens();
    // Same shape as the very first clear: a scoped delete + a legacy-root delete,
    // no matter how many times this has already run.
    expect(writes.filter((write) => write.includes('max-age=0'))).toHaveLength(2);
    expect(writes.some((write) => write.includes('path=/api/attachments') && write.includes('max-age=0'))).toBe(true);
    expect(writes.some((write) => write.includes('path=/;') && write.includes('max-age=0'))).toBe(true);
  });

  it('the scoped cookie path covers all three attachment delivery routes and no other /api subtree (AC-3)', () => {
    storeTokens({ accessToken: 'tok-1' }, 900);
    const cookiePath = parseCookieWrite(writes.find((write) => write.includes('max-age=900')) as string).path;
    expect(parseCookieWrite(writes.find((write) => write.includes('max-age=900')) as string).domain).toBeUndefined();

    const covered = [
      '/api/attachments/507f191e810c19729de860ea',
      '/api/attachments/507f191e810c19729de860ea/original',
      '/api/attachments/by-key/pages%2Fpage-1%2Fatt-1.png',
    ];
    const notCovered = ['/api/attachments-meta', '/api/attachments-upload', '/api/pages', '/api/auth/me', '/api/admin/users', '/'];

    for (const path of covered) {
      expect(cookiePathMatches(cookiePath, path)).toBe(true);
    }
    for (const path of notCovered) {
      expect(cookiePathMatches(cookiePath, path)).toBe(false);
    }
  });

  it('never adds a Domain attribute, even when a split-origin API host is configured (AC-5)', () => {
    envMock.mockReturnValue('https://api.example.com');

    storeTokens({ accessToken: 'tok-1' }, 900);
    clearTokens();

    expect(writes.length).toBeGreaterThan(0);
    for (const write of writes) {
      expect(write.toLowerCase()).not.toContain('domain=');
    }
    // `auth-token.ts` never reads the runtime env at all — the cookie shape
    // does not vary with the configured API origin.
    expect(envMock).not.toHaveBeenCalled();
  });
});
