import { isValidRedisDatabase, parseRedisDatabase, parseRedisDatabaseOrThrow } from './redis-database';

describe('parseRedisDatabase', () => {
  test('an absent pathname (no trailing slash at all) resolves to database 0', () => {
    expect(parseRedisDatabase('redis://localhost:6379')).toStrictEqual({ database: 0 });
  });

  test('an explicit root pathname ("/") resolves to database 0', () => {
    expect(parseRedisDatabase('redis://localhost:6379/')).toStrictEqual({ database: 0 });
  });

  test('"/0" resolves to database 0', () => {
    expect(parseRedisDatabase('redis://localhost:6379/0')).toStrictEqual({ database: 0 });
  });

  test('"/1" resolves to database 1', () => {
    expect(parseRedisDatabase('redis://localhost:6379/1')).toStrictEqual({ database: 1 });
  });

  test('rediss:// with ACL userinfo + "/1" still resolves to database 1 (the credentials segment does not interfere with pathname parsing)', () => {
    expect(parseRedisDatabase('rediss://ACL-user:password@host/1')).toStrictEqual({ database: 1 });
  });

  test('a larger DB index parses correctly', () => {
    expect(parseRedisDatabase('redis://localhost:6379/15')).toStrictEqual({ database: 15 });
  });

  test.each(['/foo', '/-1', '/1/extra', '/1.5'])('an invalid pathname %s is rejected, not silently defaulted', (pathname) => {
    const parsed = parseRedisDatabase(`redis://localhost:6379${pathname}`);
    expect(isValidRedisDatabase(parsed)).toBe(false);
    expect('error' in parsed && parsed.error).toEqual(expect.stringContaining(JSON.stringify(pathname)));
  });

  describe('a value that starts with "redis://"/"rediss://" but is not a syntactically valid URL', () => {
    test.each([
      'redis://[::g]:6379/0',
      'redis://host with space:6379/0',
    ])('returns the { error } shape instead of letting `new URL()` throw (%s)', (malformed) => {
      const parsed = parseRedisDatabase(malformed);
      expect(isValidRedisDatabase(parsed)).toBe(false);
      expect('error' in parsed && parsed.error).toMatch(/valid URL/);
    });

    test('redacts userinfo credentials embedded in the malformed URL from the error message', () => {
      const parsed = parseRedisDatabase('redis://default:hunter2@[::g]:6379/0');
      expect('error' in parsed && parsed.error).not.toContain('hunter2');
      expect('error' in parsed && parsed.error).toContain('***@');
    });

    test('redacts userinfo credentials even when a stray "/" appears before the "@" (a naive [^/@]* redaction regex would fail to match at all here and leak the credentials verbatim)', () => {
      const parsed = parseRedisDatabase('redis://alice:s3cr3t/path@[');
      expect(isValidRedisDatabase(parsed)).toBe(false);
      expect('error' in parsed && parsed.error).not.toContain('s3cr3t');
      expect('error' in parsed && parsed.error).toContain('***@');
    });
  });
});

describe('isValidRedisDatabase', () => {
  test('narrows the success shape', () => {
    const parsed = parseRedisDatabase('redis://localhost:6379/2');
    expect(isValidRedisDatabase(parsed)).toBe(true);
    if (isValidRedisDatabase(parsed)) {
      expect(parsed.database).toBe(2);
    }
  });

  test('narrows the failure shape', () => {
    const parsed = parseRedisDatabase('redis://localhost:6379/not-a-number');
    expect(isValidRedisDatabase(parsed)).toBe(false);
  });
});

describe('parseRedisDatabaseOrThrow', () => {
  test('returns the parsed database index for a valid pathname', () => {
    expect(parseRedisDatabaseOrThrow('redis://localhost:6379/1')).toBe(1);
  });

  test('throws (rather than returning the error shape) for an invalid pathname', () => {
    expect(() => parseRedisDatabaseOrThrow('redis://localhost:6379/foo')).toThrow(/database pathname/);
  });
});
