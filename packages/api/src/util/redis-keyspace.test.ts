import type Crowi from 'src/crowi';
import { resolveRedisKeyspace } from './redis-keyspace';

/**
 * The smallest fixture `resolveRedisKeyspace` reads from a `Crowi` —
 * `getBaseUrl()` / `getEnv()` only, matching the established pattern in
 * `collab/extension-redis.test.ts`'s `fakeCrowi()`.
 */
function fakeCrowi(clientUrl: string | null, env: Record<string, string | undefined> = {}): Crowi {
  return {
    getBaseUrl: () => clientUrl,
    getEnv: () => env as unknown as NodeJS.ProcessEnv,
  } as unknown as Crowi;
}

describe('resolveRedisKeyspace', () => {
  describe('explicit REDIS_KEY_PREFIX override', () => {
    test('a valid override is used as the slug regardless of CLIENT_URL', () => {
      const keyspace = resolveRedisKeyspace(fakeCrowi('https://wiki.example.com', { REDIS_KEY_PREFIX: 'krswd' }));
      expect(keyspace.slug).toBe('krswd');
      expect(keyspace.key('presence', 'feed')).toBe('crowi:krswd:presence:feed');
    });

    test('the override wins even when CLIENT_URL is unset', () => {
      const keyspace = resolveRedisKeyspace(fakeCrowi(null, { REDIS_KEY_PREFIX: 'krswd' }));
      expect(keyspace.slug).toBe('krswd');
    });

    test('an override containing whitespace-only content is treated as unset, falling back to CLIENT_URL', () => {
      const keyspace = resolveRedisKeyspace(fakeCrowi('https://wiki.example.com', { REDIS_KEY_PREFIX: '   ' }));
      expect(keyspace.slug).toBe('wiki.example.com');
    });

    test.each([
      ['contains a colon', 'krswd:wiki'],
      ['starts with a disallowed character', '-krswd'],
      ['contains whitespace', 'krs wd'],
      ['contains a slash', 'krswd/wiki'],
    ])('an invalid override (%s) throws instead of silently falling back — this should already have been rejected at boot', (_label, invalid) => {
      expect(() => resolveRedisKeyspace(fakeCrowi('https://wiki.example.com', { REDIS_KEY_PREFIX: invalid }))).toThrow(/REDIS_KEY_PREFIX/);
    });

    test('AC6, literal wording: two instances whose CLIENT_URL differs but share the SAME explicit REDIS_KEY_PREFIX resolve the identical keyspace, while a DIFFERENT REDIS_KEY_PREFIX isolates them even from an instance with the SAME CLIENT_URL', () => {
      const instanceA = resolveRedisKeyspace(fakeCrowi('https://wiki.example-a.com', { REDIS_KEY_PREFIX: 'krswd' }));
      const instanceBSameOverride = resolveRedisKeyspace(fakeCrowi('https://wiki.example-b.com', { REDIS_KEY_PREFIX: 'krswd' }));
      const instanceCDifferentOverride = resolveRedisKeyspace(fakeCrowi('https://wiki.example-b.com', { REDIS_KEY_PREFIX: 'other' }));

      // Same explicit override -> shared slug/key, despite CLIENT_URL differing between A and B.
      expect(instanceBSameOverride.slug).toBe(instanceA.slug);
      expect(instanceBSameOverride.key('presence', 'feed')).toBe(instanceA.key('presence', 'feed'));

      // Different explicit override -> isolated slug/key, even though C shares B's CLIENT_URL.
      expect(instanceCDifferentOverride.slug).not.toBe(instanceBSameOverride.slug);
      expect(instanceCDifferentOverride.key('presence', 'feed')).not.toBe(instanceBSameOverride.key('presence', 'feed'));
    });
  });

  describe('default: derived from CLIENT_URL hostname', () => {
    test('derives the slug from the hostname, ignoring port/path/query', () => {
      const keyspace = resolveRedisKeyspace(fakeCrowi('https://wiki.krswd.family:8443/some/path?x=1'));
      expect(keyspace.slug).toBe('wiki.krswd.family');
      expect(keyspace.prefix('collab')).toBe('crowi:wiki.krswd.family:collab');
    });

    test('a bare hostname CLIENT_URL (no subdomain) resolves too', () => {
      expect(resolveRedisKeyspace(fakeCrowi('https://example.com')).slug).toBe('example.com');
    });
  });

  describe('unresolvable — throws rather than falling back to an ambiguous default', () => {
    test('REDIS_KEY_PREFIX unset AND CLIENT_URL unset throws (mirrors the env-schema.ts cross-field boot-abort for REDIS_URL being set with neither resolvable)', () => {
      expect(() => resolveRedisKeyspace(fakeCrowi(null))).toThrow(/REDIS_KEY_PREFIX/);
    });

    test('a CLIENT_URL that fails to parse as an absolute URL throws', () => {
      expect(() => resolveRedisKeyspace(fakeCrowi('not a url at all'))).toThrow(/CLIENT_URL/);
    });

    test("an IPv6 literal CLIENT_URL hostname throws (doesn't match the slug format) rather than silently stripping brackets/colons", () => {
      expect(() => resolveRedisKeyspace(fakeCrowi('http://[::1]:3000'))).toThrow(/hostname/);
    });

    test('a CLIENT_URL that fails to parse redacts embedded userinfo credentials from the thrown message even when a stray "/" precedes the "@" (a naive [^/@]* redaction regex would fail to match at all here and leak the credentials verbatim)', () => {
      let thrown: Error | null = null;
      try {
        resolveRedisKeyspace(fakeCrowi('https://alice:s3cr3t/path@['));
      } catch (err) {
        thrown = err as Error;
      }
      expect(thrown).not.toBeNull();
      expect(thrown?.message).not.toContain('s3cr3t');
      expect(thrown?.message).toContain('***@');
    });
  });

  describe('resolves the slug once per Crowi instance (cached — AC-2)', () => {
    test('a second call with the SAME crowi reference returns the identical RedisKeyspace without re-invoking getBaseUrl/getEnv', () => {
      const getBaseUrl = jest.fn(() => 'https://wiki.example.com');
      const getEnv = jest.fn(() => ({}) as NodeJS.ProcessEnv);
      const crowi = { getBaseUrl, getEnv } as unknown as Crowi;

      const first = resolveRedisKeyspace(crowi);
      const second = resolveRedisKeyspace(crowi);

      expect(second).toBe(first);
      expect(getBaseUrl).toHaveBeenCalledTimes(1);
      expect(getEnv).toHaveBeenCalledTimes(1);
    });

    test('two distinct crowi-shaped fixtures resolve independently (no cross-instance cache leakage)', () => {
      const a = resolveRedisKeyspace(fakeCrowi('https://wiki.krswd.family'));
      const b = resolveRedisKeyspace(fakeCrowi('https://wiki.other.example'));

      expect(a.slug).toBe('wiki.krswd.family');
      expect(b.slug).toBe('wiki.other.example');
    });
  });

  describe('key() / prefix()', () => {
    test('are equivalent aliases that both join segments with the shared slug', () => {
      const keyspace = resolveRedisKeyspace(fakeCrowi('https://wiki.example.com'));
      expect(keyspace.key('ratelimit', 'login', 'user-1', '60')).toBe('crowi:wiki.example.com:ratelimit:login:user-1:60');
      expect(keyspace.prefix('ratelimit', 'login', 'user-1', '60')).toBe(keyspace.key('ratelimit', 'login', 'user-1', '60'));
    });

    test('a zero-segment call returns just "crowi:<slug>"', () => {
      const keyspace = resolveRedisKeyspace(fakeCrowi('https://wiki.example.com'));
      expect(keyspace.key()).toBe('crowi:wiki.example.com');
    });
  });
});
