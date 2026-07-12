import { ENV_VAR_DESCRIPTORS, validateEnv } from 'src/util/env-schema';

/** Minimal `NodeJS.ProcessEnv`-shaped object for a given set of overrides. */
function makeEnv(overrides: Record<string, string | undefined> = {}): NodeJS.ProcessEnv {
  return overrides as unknown as NodeJS.ProcessEnv;
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
    test('accepts redis:// and rediss://', () => {
      expect(validateEnv(makeEnv({ REDIS_URL: 'redis://localhost:6379' })).values.redisUrl).toBe('redis://localhost:6379');
      expect(validateEnv(makeEnv({ REDIS_URL: 'rediss://localhost:6379' })).values.redisUrl).toBe('rediss://localhost:6379');
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
      const result = validateEnv(makeEnv({ REDISTOGO_URL: 'redis://legacy:6379', REDIS_URL: 'redis://canonical:6379' }));
      expect(result.values.redisUrl).toBe('redis://legacy:6379');
    });

    test('unset stays null (Redis is optional)', () => {
      expect(validateEnv(makeEnv({})).values.redisUrl).toBeNull();
    });

    test('a value padded with whitespace both validates AND is used trimmed (no stale untrimmed value reaches setupRedisClient())', () => {
      const result = validateEnv(makeEnv({ REDIS_URL: '  redis://localhost:6379  ' }));
      expect(result.values.redisUrl).toBe('redis://localhost:6379');
    });

    test('a whitespace-only value is NOT treated as unset — Redis being optional only applies when the var is truly absent', () => {
      expect(() => validateEnv(makeEnv({ REDIS_URL: '   ' }))).toThrow(/REDIS_URL/);
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

  describe('JWT TTL / COLLAB_MAX_EDITORS_PER_PAGE (warn, silent-fallback made visible)', () => {
    test.each([
      'JWT_ACCESS_TOKEN_TTL_SECONDS',
      'JWT_REFRESH_TOKEN_TTL_SECONDS',
      'COLLAB_MAX_EDITORS_PER_PAGE',
    ])('%s warns on a non-positive-integer value', (name) => {
      const result = validateEnv(makeEnv({ [name]: '3600s' }));
      expect(result.warnings.some((w) => w.startsWith(`${name}:`))).toBe(true);
    });

    test.each([
      'JWT_ACCESS_TOKEN_TTL_SECONDS',
      'JWT_REFRESH_TOKEN_TTL_SECONDS',
      'COLLAB_MAX_EDITORS_PER_PAGE',
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
      const result = validateEnv(
        makeEnv({
          WS_TOKEN_SECRET: 'anything',
          REDIS_REJECT_UNAUTHORIZED: 'nonsense',
          BASE_URL: 'anything',
          PASSWORD_SEED: 'anything',
          SECRET_TOKEN: 'anything',
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
          'CROWI_ENCRYPTION_KEY',
          'CLIENT_URL',
          'CROWI_MULTI_INSTANCE',
          'NODE_ENV',
          'JWT_ACCESS_TOKEN_TTL_SECONDS',
          'JWT_REFRESH_TOKEN_TTL_SECONDS',
          'COLLAB_MAX_EDITORS_PER_PAGE',
          'MIGRATION_PREFLIGHT_UNAPPLIED_POLICY',
          'WS_TOKEN_SECRET',
          'CROWI_MIGRATE_USER',
        ]),
      );
    });

    test('MONGO_URI carries its legacy aliases', () => {
      const mongo = ENV_VAR_DESCRIPTORS.find((d) => d.name === 'MONGO_URI');
      expect(mongo?.aliases).toEqual(['MONGOLAB_URI', 'MONGODB_URI', 'MONGOHQ_URL']);
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
