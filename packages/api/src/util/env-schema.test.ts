import { ENV_VAR_DESCRIPTORS, isMultiInstanceDeclared, validateEnv } from 'src/util/env-schema';

/**
 * The default `SECRET_TOKEN` every `makeEnv()` call carries unless an
 * override replaces/removes it (pass
 * `SECRET_TOKEN: undefined` to build an unset-secret case). Keeps every
 * PRE-EXISTING test in this file — which exercises some other var entirely —
 * from incidentally tripping the new required-secret validation.
 */
const VALID_SECRET_TOKEN = 'env-schema-test-default-secret-32chars';

/** Minimal `NodeJS.ProcessEnv`-shaped object for a given set of overrides. */
function makeEnv(overrides: Record<string, string | undefined> = {}): NodeJS.ProcessEnv {
  return { SECRET_TOKEN: VALID_SECRET_TOKEN, ...overrides } as unknown as NodeJS.ProcessEnv;
}

describe('util/env-schema validateEnv', () => {
  describe('defaults (empty env)', () => {
    test('derives the documented defaults', () => {
      const result = validateEnv(makeEnv({}));

      expect(result.values).toEqual({
        baseUrl: null,
        nodeEnv: 'production',
        port: 4301,
        redisUrl: null,
        mongoUri: 'mongodb://localhost/crowi',
        encryptionKey: null,
        federatedAuthPublicUrls: null,
      });
    });

    test('warns that CLIENT_URL is unset (pre-existing behaviour, now surfaced via the consolidated report — AC-12)', () => {
      const result = validateEnv(makeEnv({}));
      expect(result.warnings).toEqual([expect.stringMatching(/^CLIENT_URL: is not set/)]);
    });
  });

  describe('PORT (fail)', () => {
    test('accepts an in-range integer', () => {
      expect(validateEnv(makeEnv({ PORT: '8080' })).values.port).toBe(8080);
    });

    test.each(['0', '65536', 'not-a-number', '3000.5', '-1'])('rejects %s', (raw) => {
      expect(() => validateEnv(makeEnv({ PORT: raw }))).toThrow(/PORT/);
    });

    test('an exactly-empty value is treated the same as unset — falls back to the default (matches the pre-existing `this.env.PORT ? … : default` truthy check)', () => {
      expect(validateEnv(makeEnv({ PORT: '' })).values.port).toBe(4301);
    });

    test('a whitespace-only value is NOT treated as unset — it is truthy (like the pre-existing check) so it fails instead of silently defaulting', () => {
      expect(() => validateEnv(makeEnv({ PORT: '   ' }))).toThrow(/PORT/);
    });
  });

  describe('MONGO_URI (fail, with aliases)', () => {
    test('accepts mongodb:// and mongodb+srv://', () => {
      expect(validateEnv(makeEnv({ MONGO_URI: 'mongodb://localhost/crowi' })).values.mongoUri).toBe('mongodb://localhost/crowi');
      expect(validateEnv(makeEnv({ MONGO_URI: 'mongodb+srv://cluster0.example.net/crowi' })).values.mongoUri).toBe('mongodb+srv://cluster0.example.net/crowi');
    });

    test('rejects a value with the wrong scheme', () => {
      expect(() => validateEnv(makeEnv({ MONGO_URI: 'postgres://localhost/crowi' }))).toThrow(/MONGO_URI/);
    });

    test('MONGOLAB_URI takes precedence over MONGO_URI (legacy B.C. ordering)', () => {
      const result = validateEnv(makeEnv({ MONGOLAB_URI: 'mongodb://legacy/db', MONGO_URI: 'mongodb://canonical/db' }));
      expect(result.values.mongoUri).toBe('mongodb://legacy/db');
    });

    test('an invalid alias fails even when the canonical name is unset', () => {
      expect(() => validateEnv(makeEnv({ MONGOHQ_URL: 'not-a-uri' }))).toThrow(/MONGOHQ_URL/);
    });

    test('a value padded with whitespace both validates AND is used trimmed (no stale untrimmed value reaches setupDatabase())', () => {
      const result = validateEnv(makeEnv({ MONGO_URI: '  mongodb://localhost/crowi  ' }));
      expect(result.values.mongoUri).toBe('mongodb://localhost/crowi');
    });

    test('a whitespace-only alias is NOT treated as unset — it wins precedence (matching the pre-existing `||` chain) and fails instead of silently falling through to a later alias', () => {
      expect(() => validateEnv(makeEnv({ MONGOLAB_URI: '   ', MONGO_URI: 'mongodb://canonical/db' }))).toThrow(/MONGOLAB_URI/);
    });

    test('embedded userinfo credentials are redacted from the boot-abort message, not echoed verbatim', () => {
      let thrown: Error | null = null;
      try {
        validateEnv(makeEnv({ MONGO_URI: 'postgres://admin:hunter2@localhost/crowi' }));
      } catch (err) {
        thrown = err as Error;
      }
      expect(thrown).not.toBeNull();
      expect(thrown?.message).not.toContain('hunter2');
      expect(thrown?.message).not.toContain('admin:hunter2');
      expect(thrown?.message).toContain('***@localhost');
    });
  });

  describe('REDIS_URL (fail, with aliases)', () => {
    test('accepts redis:// and rediss:// (CLIENT_URL set so the feature-redis-key-prefix keyspace-resolvability invariant, covered separately below, does not also fire)', () => {
      expect(validateEnv(makeEnv({ REDIS_URL: 'redis://localhost:6379', CLIENT_URL: 'https://wiki.example.com' })).values.redisUrl).toBe(
        'redis://localhost:6379',
      );
      expect(validateEnv(makeEnv({ REDIS_URL: 'rediss://localhost:6379', CLIENT_URL: 'https://wiki.example.com' })).values.redisUrl).toBe(
        'rediss://localhost:6379',
      );
    });

    test('rejects a value with the wrong scheme', () => {
      expect(() => validateEnv(makeEnv({ REDIS_URL: 'http://localhost:6379' }))).toThrow(/REDIS_URL/);
    });

    test('embedded userinfo credentials are redacted from the boot-abort message, not echoed verbatim', () => {
      let thrown: Error | null = null;
      try {
        validateEnv(makeEnv({ REDIS_URL: 'http://default:hunter2@localhost:6379' }));
      } catch (err) {
        thrown = err as Error;
      }
      expect(thrown).not.toBeNull();
      expect(thrown?.message).not.toContain('hunter2');
      expect(thrown?.message).toContain('***@localhost:6379');
    });

    test('REDISTOGO_URL takes precedence over REDIS_URL (legacy ordering)', () => {
      const result = validateEnv(
        makeEnv({ REDISTOGO_URL: 'redis://legacy:6379', REDIS_URL: 'redis://canonical:6379', CLIENT_URL: 'https://wiki.example.com' }),
      );
      expect(result.values.redisUrl).toBe('redis://legacy:6379');
    });

    test('unset stays null (Redis is optional)', () => {
      expect(validateEnv(makeEnv({})).values.redisUrl).toBeNull();
    });

    test('a value padded with whitespace both validates AND is used trimmed (no stale untrimmed value reaches setupRedisClient())', () => {
      const result = validateEnv(makeEnv({ REDIS_URL: '  redis://localhost:6379  ', CLIENT_URL: 'https://wiki.example.com' }));
      expect(result.values.redisUrl).toBe('redis://localhost:6379');
    });

    test('a whitespace-only value is NOT treated as unset — Redis being optional only applies when the var is truly absent', () => {
      expect(() => validateEnv(makeEnv({ REDIS_URL: '   ' }))).toThrow(/REDIS_URL/);
    });

    describe('feature-redis-key-prefix §3: the database pathname', () => {
      test.each([
        'redis://localhost:6379',
        'redis://localhost:6379/',
        'redis://localhost:6379/0',
        'redis://localhost:6379/1',
      ])('%s (root/absent, or a non-negative integer) validates', (raw) => {
        expect(() => validateEnv(makeEnv({ REDIS_URL: raw, CLIENT_URL: 'https://wiki.example.com' }))).not.toThrow();
      });

      test('an ACL rediss:// URL with a database pathname validates', () => {
        expect(() => validateEnv(makeEnv({ REDIS_URL: 'rediss://ACL-user:password@host/1', CLIENT_URL: 'https://wiki.example.com' }))).not.toThrow();
      });

      test.each([
        'redis://localhost:6379/foo',
        'redis://localhost:6379/-1',
        'redis://localhost:6379/1/extra',
      ])('%s (invalid pathname) fails boot instead of silently connecting to DB 0', (raw) => {
        expect(() => validateEnv(makeEnv({ REDIS_URL: raw, CLIENT_URL: 'https://wiki.example.com' }))).toThrow(/REDIS_URL/);
      });

      test.each([
        'redis://[::g]:6379/0',
        'redis://host with space:6379/0',
      ])('a value with the correct "redis://" scheme prefix but not a syntactically valid URL (%s) is aggregated into the boot-abort message rather than throwing an unrelated TypeError out of `new URL()`', (raw) => {
        expect(() => validateEnv(makeEnv({ REDIS_URL: raw, CLIENT_URL: 'https://wiki.example.com' }))).toThrow(/REDIS_URL/);
      });
    });
  });

  describe('REDIS_KEY_PREFIX (fail) — feature-redis-key-prefix §1', () => {
    test.each(['krswd', 'krswd-wiki', 'krswd.wiki', 'krswd_wiki', 'a', 'A1'])('%s validates', (raw) => {
      expect(() => validateEnv(makeEnv({ REDIS_KEY_PREFIX: raw }))).not.toThrow();
    });

    test('an unset REDIS_KEY_PREFIX (with no REDIS_URL) does not fail', () => {
      expect(() => validateEnv(makeEnv({}))).not.toThrow();
    });

    test('a whitespace-only value fails (blank slug)', () => {
      expect(() => validateEnv(makeEnv({ REDIS_KEY_PREFIX: '   ' }))).toThrow(/REDIS_KEY_PREFIX/);
    });

    test('a value containing ":" fails (colon is the keyspace segment separator)', () => {
      expect(() => validateEnv(makeEnv({ REDIS_KEY_PREFIX: 'krswd:wiki' }))).toThrow(/REDIS_KEY_PREFIX/);
    });

    test.each(['-krswd', 'krs wd', 'krswd/wiki', 'krswd@wiki'])('%s (does not match the allowed character set) fails', (raw) => {
      expect(() => validateEnv(makeEnv({ REDIS_KEY_PREFIX: raw }))).toThrow(/REDIS_KEY_PREFIX/);
    });
  });

  describe('feature-redis-key-prefix §1: REDIS_URL + REDIS_KEY_PREFIX + CLIENT_URL cross-field keyspace-resolvability invariant', () => {
    test('REDIS_URL unset never fails regardless of REDIS_KEY_PREFIX/CLIENT_URL', () => {
      expect(() => validateEnv(makeEnv({}))).not.toThrow();
      expect(() => validateEnv(makeEnv({ CLIENT_URL: 'not-absolute' }))).not.toThrow();
    });

    test('REDIS_URL set with an explicit REDIS_KEY_PREFIX override validates even without CLIENT_URL', () => {
      expect(() => validateEnv(makeEnv({ REDIS_URL: 'redis://localhost:6379', REDIS_KEY_PREFIX: 'krswd' }))).not.toThrow();
    });

    test('REDIS_URL set with a valid CLIENT_URL validates even without REDIS_KEY_PREFIX', () => {
      expect(() => validateEnv(makeEnv({ REDIS_URL: 'redis://localhost:6379', CLIENT_URL: 'https://wiki.example.com' }))).not.toThrow();
    });

    test('REDIS_URL set with BOTH a valid REDIS_KEY_PREFIX and CLIENT_URL validates', () => {
      expect(() =>
        validateEnv(makeEnv({ REDIS_URL: 'redis://localhost:6379', REDIS_KEY_PREFIX: 'krswd', CLIENT_URL: 'https://wiki.example.com' })),
      ).not.toThrow();
    });

    test('REDIS_URL set with NEITHER REDIS_KEY_PREFIX nor CLIENT_URL fails boot instead of silently falling back to an ambiguous default', () => {
      expect(() => validateEnv(makeEnv({ REDIS_URL: 'redis://localhost:6379' }))).toThrow(/REDIS_KEY_PREFIX/);
    });

    test('REDIS_URL set with an unset REDIS_KEY_PREFIX and a non-absolute CLIENT_URL fails (CLIENT_URL must itself be valid, not merely present)', () => {
      expect(() => validateEnv(makeEnv({ REDIS_URL: 'redis://localhost:6379', CLIENT_URL: 'not-absolute' }))).toThrow(/REDIS_KEY_PREFIX/);
    });

    test.each([
      'http://[::1]:3000',
      'http://[2001:db8::1]',
    ])('REDIS_URL set with an unset REDIS_KEY_PREFIX and an IPv6-literal CLIENT_URL (%s) fails — absolute per validateAbsoluteUrl but its hostname does not fit the slug format, so util/redis-keyspace.ts could not actually resolve a slug from it at runtime', (clientUrl) => {
      let thrown: Error | null = null;
      try {
        validateEnv(makeEnv({ REDIS_URL: 'redis://localhost:6379', CLIENT_URL: clientUrl }));
      } catch (err) {
        thrown = err as Error;
      }
      expect(thrown).not.toBeNull();
      // Not just the generic "neither ... is available" wording — the
      // message must name the SPECIFIC problem (the CLIENT_URL hostname
      // doesn't fit the slug format), via resolveClientUrlSlug()'s own
      // `.error`, while still instructing to set REDIS_KEY_PREFIX.
      expect(thrown?.message).toMatch(/CLIENT_URL's hostname/);
      expect(thrown?.message).toMatch(/does not match/);
      expect(thrown?.message).toMatch(/REDIS_KEY_PREFIX/);
    });

    test('REDIS_URL set with an invalid REDIS_KEY_PREFIX override still fails, but ONLY reports the format problem, not the cross-field one (the format check already covers it)', () => {
      let thrown: Error | null = null;
      try {
        validateEnv(makeEnv({ REDIS_URL: 'redis://localhost:6379', REDIS_KEY_PREFIX: 'bad:prefix' }));
      } catch (err) {
        thrown = err as Error;
      }
      expect(thrown).not.toBeNull();
      const matches = (thrown?.message.match(/REDIS_KEY_PREFIX/g) ?? []).length;
      expect(matches).toBe(1);
    });
  });

  describe('CROWI_ENCRYPTION_KEY (fail)', () => {
    test('accepts a base64-encoded 32-byte key', () => {
      const key = Buffer.alloc(32, 1).toString('base64');
      expect(() => validateEnv(makeEnv({ CROWI_ENCRYPTION_KEY: key }))).not.toThrow();
    });

    test('rejects a key that does not decode to 32 bytes', () => {
      const shortKey = Buffer.alloc(16, 1).toString('base64');
      expect(() => validateEnv(makeEnv({ CROWI_ENCRYPTION_KEY: shortKey }))).toThrow(/CROWI_ENCRYPTION_KEY/);
    });

    test('unset does not fail (legacy plaintext mode is a warning elsewhere, not a schema concern)', () => {
      expect(() => validateEnv(makeEnv({}))).not.toThrow();
    });

    test('a valid key is surfaced trimmed on values.encryptionKey', () => {
      const key = Buffer.alloc(32, 1).toString('base64');
      expect(validateEnv(makeEnv({ CROWI_ENCRYPTION_KEY: `  ${key}  ` })).values.encryptionKey).toBe(key);
    });

    test('unset leaves values.encryptionKey null', () => {
      expect(validateEnv(makeEnv({})).values.encryptionKey).toBeNull();
    });

    test('a whitespace-only value is NOT treated as unset — it is truthy (matching the pre-existing `if (!raw)` check in setupEncryption()), so it fails just like any other malformed key', () => {
      expect(() => validateEnv(makeEnv({ CROWI_ENCRYPTION_KEY: '   ' }))).toThrow(/CROWI_ENCRYPTION_KEY/);
    });
  });

  describe('AC-13: multiple fail-severity problems are reported together', () => {
    test('a single thrown Error lists every invalid variable, not just the first', () => {
      let thrown: Error | null = null;
      try {
        validateEnv(
          makeEnv({
            PORT: 'not-a-number',
            MONGO_URI: 'postgres://localhost/crowi',
            REDIS_URL: 'not-a-redis-url',
            CROWI_ENCRYPTION_KEY: 'tooshort',
          }),
        );
      } catch (err) {
        thrown = err as Error;
      }

      expect(thrown).not.toBeNull();
      expect(thrown?.message).toMatch(/PORT/);
      expect(thrown?.message).toMatch(/MONGO_URI/);
      expect(thrown?.message).toMatch(/REDIS_URL/);
      expect(thrown?.message).toMatch(/CROWI_ENCRYPTION_KEY/);
    });
  });

  describe('CLIENT_URL (warn)', () => {
    test('unset warns (mail links would be relative — pre-existing behaviour, now consolidated)', () => {
      const result = validateEnv(makeEnv({}));
      expect(result.warnings.some((w) => w.startsWith('CLIENT_URL: is not set'))).toBe(true);
    });

    test('a valid absolute URL produces no warning', () => {
      expect(validateEnv(makeEnv({ CLIENT_URL: 'https://wiki.example.com' })).warnings).toEqual([]);
    });

    test('a non-absolute value warns (does not fail)', () => {
      const result = validateEnv(makeEnv({ CLIENT_URL: 'wiki.example.com' }));
      expect(result.warnings.some((w) => w.startsWith('CLIENT_URL:'))).toBe(true);
    });

    test.each([
      'https://',
      'http://',
      'not a url at all',
      'ftp://example.com',
      '   ',
    ])('AC-9: %s (parses but is not a valid http(s) absolute URL, or fails to parse) warns', (raw) => {
      const result = validateEnv(makeEnv({ CLIENT_URL: raw }));
      expect(result.warnings.some((w) => w.startsWith('CLIENT_URL:'))).toBe(true);
    });
  });

  describe('CROWI_MULTI_INSTANCE (warn)', () => {
    test.each(['1', '0', 'true', 'false', '2', '10'])('%s produces no warning', (raw) => {
      expect(validateEnv(makeEnv({ CROWI_MULTI_INSTANCE: raw, CLIENT_URL: 'https://wiki.example.com' })).warnings).toEqual([]);
    });

    test('a typo like "flase" warns instead of silently enabling multi-instance', () => {
      const result = validateEnv(makeEnv({ CROWI_MULTI_INSTANCE: 'flase' }));
      expect(result.warnings.some((w) => w.startsWith('CROWI_MULTI_INSTANCE:'))).toBe(true);
    });
  });

  describe('isMultiInstanceDeclared (runtime truth table — moved here from src/collab/attach.ts)', () => {
    test.each([
      [undefined, false],
      ['', false],
      ['0', false],
      ['false', false],
      ['FALSE', false],
      ['true', true],
      ['TRUE', true],
      ['1', true],
      ['2', true],
      ['10', true],
      ['flase', true], // non-numeric non-boolean string: truthy declaration (typo still enables multi-instance, and warns separately)
    ])('CROWI_MULTI_INSTANCE=%s -> %s', (raw, expected) => {
      expect(isMultiInstanceDeclared(makeEnv({ CROWI_MULTI_INSTANCE: raw }))).toBe(expected);
    });

    test('defaults to reading process.env when no argument is given', () => {
      const original = process.env.CROWI_MULTI_INSTANCE;
      try {
        delete process.env.CROWI_MULTI_INSTANCE;
        expect(isMultiInstanceDeclared()).toBe(false);
        process.env.CROWI_MULTI_INSTANCE = 'true';
        expect(isMultiInstanceDeclared()).toBe(true);
      } finally {
        if (original === undefined) delete process.env.CROWI_MULTI_INSTANCE;
        else process.env.CROWI_MULTI_INSTANCE = original;
      }
    });
  });

  describe('NODE_ENV (warn)', () => {
    test.each(['development', 'production', 'test'])('%s produces no warning', (raw) => {
      expect(validateEnv(makeEnv({ NODE_ENV: raw, CLIENT_URL: 'https://wiki.example.com' })).warnings).toEqual([]);
    });

    test('an unrecognised value warns and still derives a value', () => {
      const result = validateEnv(makeEnv({ NODE_ENV: 'staging' }));
      expect(result.values.nodeEnv).toBe('staging');
      expect(result.warnings.some((w) => w.startsWith('NODE_ENV:'))).toBe(true);
    });
  });

  describe('JWT TTL / COLLAB_MAX_EDITORS_PER_PAGE / IMAGE_DERIVATIVE_* / CROWI_UPLOAD_MAX_BYTES (warn, silent-fallback made visible)', () => {
    test.each([
      'JWT_ACCESS_TOKEN_TTL_SECONDS',
      'JWT_REFRESH_TOKEN_TTL_SECONDS',
      'COLLAB_MAX_EDITORS_PER_PAGE',
      'IMAGE_DERIVATIVE_MAX_PIXELS',
      'IMAGE_DERIVATIVE_ADMISSION_CONCURRENCY',
      'IMAGE_DERIVATIVE_ADMISSION_TIMEOUT_MS',
      'CROWI_UPLOAD_MAX_BYTES',
    ])('%s warns on a non-positive-integer value', (name) => {
      const result = validateEnv(makeEnv({ [name]: '3600s' }));
      expect(result.warnings.some((w) => w.startsWith(`${name}:`))).toBe(true);
    });

    test.each([
      'JWT_ACCESS_TOKEN_TTL_SECONDS',
      'JWT_REFRESH_TOKEN_TTL_SECONDS',
      'COLLAB_MAX_EDITORS_PER_PAGE',
      'IMAGE_DERIVATIVE_MAX_PIXELS',
      'IMAGE_DERIVATIVE_ADMISSION_CONCURRENCY',
      'IMAGE_DERIVATIVE_ADMISSION_TIMEOUT_MS',
      'CROWI_UPLOAD_MAX_BYTES',
    ])('%s produces no warning for a positive integer', (name) => {
      const result = validateEnv(makeEnv({ [name]: '3600', CLIENT_URL: 'https://wiki.example.com' }));
      expect(result.warnings).toEqual([]);
    });
  });

  describe('MIGRATION_PREFLIGHT_UNAPPLIED_POLICY (warn)', () => {
    test.each(['warn', 'block'])('%s produces no warning', (raw) => {
      expect(validateEnv(makeEnv({ MIGRATION_PREFLIGHT_UNAPPLIED_POLICY: raw, CLIENT_URL: 'https://wiki.example.com' })).warnings).toEqual([]);
    });

    test('an unrecognised value warns', () => {
      const result = validateEnv(makeEnv({ MIGRATION_PREFLIGHT_UNAPPLIED_POLICY: 'ignore' }));
      expect(result.warnings.some((w) => w.startsWith('MIGRATION_PREFLIGHT_UNAPPLIED_POLICY:'))).toBe(true);
    });
  });

  describe('SECRET_TOKEN (required; NODE_ENV-dependent minimum length; legacy WS_TOKEN_SECRET alias — feature-unified-signing-secret §D-2)', () => {
    test.each([
      ['production', undefined],
      ['development', 'true'],
      ['test', '1'],
    ])('unset (and no WS_TOKEN_SECRET alias either) fails boot with NODE_ENV=%s CROWI_MULTI_INSTANCE=%s, naming the variable and the generation command', (nodeEnv, multi) => {
      let thrown: Error | null = null;
      try {
        validateEnv(makeEnv({ SECRET_TOKEN: undefined, NODE_ENV: nodeEnv, CROWI_MULTI_INSTANCE: multi }));
      } catch (err) {
        thrown = err as Error;
      }
      expect(thrown).not.toBeNull();
      expect(thrown?.message).toContain('SECRET_TOKEN');
      expect(thrown?.message).toContain('openssl rand -base64 32');
    });

    test('an empty string fails the same way as unset', () => {
      expect(() => validateEnv(makeEnv({ SECRET_TOKEN: '' }))).toThrow(/SECRET_TOKEN/);
    });

    test.each(['development', 'test', 'production'])('a whitespace-only value fails even under NODE_ENV=%s', (nodeEnv) => {
      expect(() => validateEnv(makeEnv({ SECRET_TOKEN: '   ', NODE_ENV: nodeEnv }))).toThrow(/SECRET_TOKEN/);
    });

    test.each([
      'dev-only-ws-token-secret-replace-in-production-0000=',
      'changeme',
      'change-me',
      'replace-me',
      'your-secret-here',
      'your-secret-key',
      'this is default session secret',
    ])('the known placeholder %s fails even under NODE_ENV=development (not just production)', (placeholder) => {
      expect(() => validateEnv(makeEnv({ SECRET_TOKEN: placeholder, NODE_ENV: 'development' }))).toThrow(/SECRET_TOKEN/);
    });

    test('a placeholder is matched case-insensitively after trim', () => {
      expect(() => validateEnv(makeEnv({ SECRET_TOKEN: '  ChangeMe  ' }))).toThrow(/SECRET_TOKEN/);
    });

    test('NODE_ENV=production with a non-placeholder 1-31 char value fails boot, message names the variable and required length only — no generation command or rename guidance (AC-3: those appear only on the required/placeholder message)', () => {
      let thrown: Error | null = null;
      try {
        validateEnv(makeEnv({ NODE_ENV: 'production', SECRET_TOKEN: 'short-secret' }));
      } catch (err) {
        thrown = err as Error;
      }
      expect(thrown).not.toBeNull();
      expect(thrown?.message).toContain('SECRET_TOKEN');
      expect(thrown?.message).toMatch(/at least 32 characters/);
      expect(thrown?.message).not.toContain('openssl rand -base64 32');
      expect(thrown?.message).not.toContain('rename');
    });

    test("an unset NODE_ENV defaults to the production (strict) severity, matching values.nodeEnv's own fallback", () => {
      expect(() => validateEnv(makeEnv({ NODE_ENV: undefined, SECRET_TOKEN: 'short-secret' }))).toThrow(/SECRET_TOKEN/);
    });

    test.each(['development', 'test', 'staging'])('NODE_ENV=%s with the same short value warns instead of failing boot', (nodeEnv) => {
      const result = validateEnv(makeEnv({ NODE_ENV: nodeEnv, SECRET_TOKEN: 'short-secret' }));
      expect(result.warnings.some((w) => w.startsWith('SECRET_TOKEN:') && w.includes('at least 32 characters'))).toBe(true);
    });

    test('the short-value message never echoes the actual secret', () => {
      const result = validateEnv(makeEnv({ NODE_ENV: 'development', SECRET_TOKEN: 'a-short-one' }));
      expect(result.warnings.join('\n')).not.toContain('a-short-one');
    });

    test('a value >= 32 characters passes with no warning, in production or otherwise', () => {
      const strong = 'a'.repeat(32);
      expect(validateEnv(makeEnv({ NODE_ENV: 'production', SECRET_TOKEN: strong, CLIENT_URL: 'https://wiki.example.com' })).warnings).toEqual([]);
      expect(validateEnv(makeEnv({ NODE_ENV: 'development', SECRET_TOKEN: strong, CLIENT_URL: 'https://wiki.example.com' })).warnings).toEqual([]);
    });

    describe('CROWI_MULTI_INSTANCE has no bearing on SECRET_TOKEN required validation (D-4: the removed multi-instance-only guard has no successor)', () => {
      test.each([undefined, 'false', '0', 'true', '1', '4'])('a valid SECRET_TOKEN passes with CROWI_MULTI_INSTANCE=%s', (multi) => {
        expect(() => validateEnv(makeEnv({ SECRET_TOKEN: 'a'.repeat(32), CROWI_MULTI_INSTANCE: multi }))).not.toThrow();
      });

      test('a placeholder still fails even with CROWI_MULTI_INSTANCE unset (single-instance is no longer exempt)', () => {
        expect(() => validateEnv(makeEnv({ SECRET_TOKEN: 'changeme', CROWI_MULTI_INSTANCE: undefined }))).toThrow(/SECRET_TOKEN/);
      });
    });

    describe('legacy WS_TOKEN_SECRET alias', () => {
      test('a valid WS_TOKEN_SECRET alone satisfies the requirement with no warning', () => {
        const strong = 'b'.repeat(32);
        const result = validateEnv(makeEnv({ SECRET_TOKEN: undefined, WS_TOKEN_SECRET: strong, CLIENT_URL: 'https://wiki.example.com' }));
        expect(result.warnings).toEqual([]);
      });

      test('WS_TOKEN_SECRET takes precedence over SECRET_TOKEN when both are set to the same value — no divergence warning', () => {
        const same = 'a'.repeat(32);
        const result = validateEnv(makeEnv({ SECRET_TOKEN: same, WS_TOKEN_SECRET: same, CLIENT_URL: 'https://wiki.example.com' }));
        expect(result.warnings).toEqual([]);
      });

      test('AC-12: both set to different values warns exactly once, names WS_TOKEN_SECRET as the winner, and never echoes either value', () => {
        const canonical = 'a'.repeat(32);
        const alias = 'b'.repeat(32);
        const result = validateEnv(makeEnv({ SECRET_TOKEN: canonical, WS_TOKEN_SECRET: alias }));
        const matches = result.warnings.filter((w) => w.startsWith('SECRET_TOKEN:') && w.includes('WS_TOKEN_SECRET'));
        expect(matches).toHaveLength(1);
        expect(matches[0]).not.toContain(canonical);
        expect(matches[0]).not.toContain(alias);
      });

      test('AC-12: only WS_TOKEN_SECRET set never warns about divergence', () => {
        const result = validateEnv(makeEnv({ SECRET_TOKEN: undefined, WS_TOKEN_SECRET: 'd'.repeat(32), CLIENT_URL: 'https://wiki.example.com' }));
        expect(result.warnings).toEqual([]);
      });

      test('AC-12: only SECRET_TOKEN set never warns about divergence', () => {
        const result = validateEnv(makeEnv({ SECRET_TOKEN: 'e'.repeat(32), CLIENT_URL: 'https://wiki.example.com' }));
        expect(result.warnings).toEqual([]);
      });

      test('a whitespace-padded WS_TOKEN_SECRET winner is trimmed for the length/placeholder checks the same way as the canonical name', () => {
        const result = validateEnv(makeEnv({ SECRET_TOKEN: undefined, WS_TOKEN_SECRET: `  ${'f'.repeat(32)}  `, CLIENT_URL: 'https://wiki.example.com' }));
        expect(result.warnings).toEqual([]);
      });

      test('AC-12: a padded WS_TOKEN_SECRET winner that trims equal to SECRET_TOKEN still warns — the raw values actually used to sign differ even though the trimmed values match', () => {
        const value = 'g'.repeat(32);
        const result = validateEnv(makeEnv({ SECRET_TOKEN: value, WS_TOKEN_SECRET: `  ${value}  `, CLIENT_URL: 'https://wiki.example.com' }));
        const matches = result.warnings.filter((w) => w.startsWith('SECRET_TOKEN:') && w.includes('WS_TOKEN_SECRET'));
        expect(matches).toHaveLength(1);
        expect(matches[0]).not.toContain(value);
      });
    });
  });

  describe('AC-11: typo detection heuristic', () => {
    test('a near-miss of a known Crowi-prefixed variable warns with a suggestion', () => {
      const result = validateEnv(makeEnv({ CROWI_ENCRYPTON_KEY: 'whatever' }));
      const match = result.warnings.find((w) => w.startsWith('CROWI_ENCRYPTON_KEY:'));
      expect(match).toBeDefined();
      expect(match).toMatch(/CROWI_ENCRYPTION_KEY/);
    });

    test('a near-miss with a legacy alias also warns', () => {
      const result = validateEnv(makeEnv({ WS_TOKEN_SECRETT: 'whatever' }));
      expect(result.warnings.some((w) => w.startsWith('WS_TOKEN_SECRETT:'))).toBe(true);
    });

    test('a far-off Crowi-prefixed key does not warn (heuristic, false negatives are fine)', () => {
      const result = validateEnv(makeEnv({ CROWI_TOTALLY_UNRELATED_SETTING_NAME: 'x' }));
      expect(result.warnings.some((w) => w.startsWith('CROWI_TOTALLY_UNRELATED_SETTING_NAME:'))).toBe(false);
    });

    test('unrelated OS/CI env vars are never flagged (no Crowi prefix)', () => {
      const result = validateEnv(
        makeEnv({
          PATH: '/usr/bin',
          CI: 'true',
          GITHUB_ACTIONS: 'true',
          npm_config_registry: 'https://registry.npmjs.org/',
          HOME: '/home/runner',
          CLIENT_URL: 'https://wiki.example.com',
        }),
      );
      expect(result.warnings).toEqual([]);
    });

    test('known-but-web/plugin-owned vars are recognised and never flagged', () => {
      const result = validateEnv(
        makeEnv({
          NEXT_PUBLIC_API_URL: 'https://api.example.com',
          NEXT_PUBLIC_COLLAB_URL: 'wss://collab.example.com',
          CROWI_API_URL: 'http://api:3000',
          SLACK_MANIFEST_REQUEST_URL: 'https://abc123.ngrok.app',
          CLIENT_URL: 'https://wiki.example.com',
        }),
      );
      expect(result.warnings).toEqual([]);
    });

    test('exact known names (including taxonomy-only ones) never warn regardless of content', () => {
      // SECRET_TOKEN/WS_TOKEN_SECRET are excluded from the "arbitrary
      // content" claim below (they are no longer taxonomy-only — see the
      // dedicated SECRET_TOKEN describe block) but are set here to the SAME
      // >= 32 char value so the typo heuristic's own claim is exercised
      // without also tripping the length check or the AC-12 divergence
      // warning.
      const strongSecret = 'x'.repeat(40);
      const result = validateEnv(
        makeEnv({
          SECRET_TOKEN: strongSecret,
          WS_TOKEN_SECRET: strongSecret,
          REDIS_REJECT_UNAUTHORIZED: 'nonsense',
          BASE_URL: 'anything',
          PASSWORD_SEED: 'anything',
          ENABLE_DNSCACHE: 'anything',
          DEBUG: 'crowi:*',
          CROWI_MIGRATE_USER: 'admin@example.com',
          CLIENT_URL: 'https://wiki.example.com',
        }),
      );
      expect(result.warnings).toEqual([]);
    });

    test('a near-miss of CROWI_MIGRATE_USER (migration/helpers.ts:resolveActingUserId) warns with a suggestion', () => {
      const result = validateEnv(makeEnv({ CROWI_MIGRATE_USR: 'admin@example.com' }));
      expect(result.warnings.some((w) => w.startsWith('CROWI_MIGRATE_USR:') && w.includes('CROWI_MIGRATE_USER'))).toBe(true);
    });
  });

  describe('AC-1: the descriptor taxonomy itself is exported', () => {
    test('ENV_VAR_DESCRIPTORS covers every var this suite exercises, including taxonomy-only ones', () => {
      const names = ENV_VAR_DESCRIPTORS.map((d) => d.name);
      expect(names).toEqual(
        expect.arrayContaining([
          'PORT',
          'MONGO_URI',
          'REDIS_URL',
          'REDIS_KEY_PREFIX',
          'CROWI_ENCRYPTION_KEY',
          'CLIENT_URL',
          'CROWI_MULTI_INSTANCE',
          'NODE_ENV',
          'JWT_ACCESS_TOKEN_TTL_SECONDS',
          'JWT_REFRESH_TOKEN_TTL_SECONDS',
          'COLLAB_MAX_EDITORS_PER_PAGE',
          'MIGRATION_PREFLIGHT_UNAPPLIED_POLICY',
          'SECRET_TOKEN',
          'CROWI_MIGRATE_USER',
          'IMAGE_DERIVATIVE_MAX_PIXELS',
          'IMAGE_DERIVATIVE_ADMISSION_CONCURRENCY',
          'IMAGE_DERIVATIVE_ADMISSION_TIMEOUT_MS',
          'CROWI_UPLOAD_MAX_BYTES',
        ]),
      );
      // WS_TOKEN_SECRET is registered as SECRET_TOKEN's alias, not as its
      // own top-level descriptor name.
      expect(names).not.toContain('WS_TOKEN_SECRET');
    });

    test('MONGO_URI carries its legacy aliases', () => {
      const mongo = ENV_VAR_DESCRIPTORS.find((d) => d.name === 'MONGO_URI');
      expect(mongo?.aliases).toEqual(['MONGOLAB_URI', 'MONGODB_URI', 'MONGOHQ_URL']);
    });

    test('SECRET_TOKEN carries the legacy WS_TOKEN_SECRET alias', () => {
      const secretToken = ENV_VAR_DESCRIPTORS.find((d) => d.name === 'SECRET_TOKEN');
      expect(secretToken?.aliases).toEqual(['WS_TOKEN_SECRET']);
    });
  });

  describe('AC-2: baseUrl is carried over verbatim (BASE_URL, distinct from CLIENT_URL)', () => {
    test('BASE_URL is used as-is with no format check', () => {
      expect(validateEnv(makeEnv({ BASE_URL: 'not a url at all' })).values.baseUrl).toBe('not a url at all');
    });

    test('unset BASE_URL is null even when CLIENT_URL is set', () => {
      expect(validateEnv(makeEnv({ CLIENT_URL: 'https://wiki.example.com' })).values.baseUrl).toBeNull();
    });
  });
});
