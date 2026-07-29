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

  describe('JWT TTL / COLLAB_MAX_EDITORS_PER_PAGE / IMAGE_DERIVATIVE_* (warn, silent-fallback made visible)', () => {
    test.each([
      'JWT_ACCESS_TOKEN_TTL_SECONDS',
      'JWT_REFRESH_TOKEN_TTL_SECONDS',
      'COLLAB_MAX_EDITORS_PER_PAGE',
      'IMAGE_DERIVATIVE_MAX_PIXELS',
      'IMAGE_DERIVATIVE_ADMISSION_CONCURRENCY',
      'IMAGE_DERIVATIVE_ADMISSION_TIMEOUT_MS',
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

  describe('WS_TOKEN_SECRET (NODE_ENV-dependent minimum length — feature-signed-token-secret-strength)', () => {
    test('NODE_ENV=production with a 1-31 char value fails boot, message names the variable, required length, and the openssl generation command', () => {
      let thrown: Error | null = null;
      try {
        validateEnv(makeEnv({ NODE_ENV: 'production', WS_TOKEN_SECRET: 'short-secret', CLIENT_URL: 'https://wiki.example.com' }));
      } catch (err) {
        thrown = err as Error;
      }
      expect(thrown).not.toBeNull();
      expect(thrown?.message).toContain('WS_TOKEN_SECRET');
      expect(thrown?.message).toMatch(/at least 32 characters/);
      expect(thrown?.message).toContain('openssl rand -base64 32');
    });

    test("an unset NODE_ENV defaults to the production (strict) severity, matching values.nodeEnv's own fallback", () => {
      expect(() => validateEnv(makeEnv({ WS_TOKEN_SECRET: 'short-secret', CLIENT_URL: 'https://wiki.example.com' }))).toThrow(/WS_TOKEN_SECRET/);
    });

    test.each(['development', 'test', 'staging'])('NODE_ENV=%s with the same short value warns instead of failing boot', (nodeEnv) => {
      const result = validateEnv(makeEnv({ NODE_ENV: nodeEnv, WS_TOKEN_SECRET: 'short-secret', CLIENT_URL: 'https://wiki.example.com' }));
      expect(result.warnings.some((w) => w.startsWith('WS_TOKEN_SECRET:') && w.includes('at least 32 characters'))).toBe(true);
    });

    test('a value >= 32 characters passes with no warning, in production or otherwise', () => {
      const strong = 'a'.repeat(32);
      expect(validateEnv(makeEnv({ NODE_ENV: 'production', WS_TOKEN_SECRET: strong, CLIENT_URL: 'https://wiki.example.com' })).warnings).toEqual([]);
      expect(validateEnv(makeEnv({ NODE_ENV: 'development', WS_TOKEN_SECRET: strong, CLIENT_URL: 'https://wiki.example.com' })).warnings).toEqual([]);
    });

    test('a known placeholder value is exempt even in production — signed-token-factory.ts already treats it as unset (random fallback + its own warning)', () => {
      const result = validateEnv(makeEnv({ NODE_ENV: 'production', WS_TOKEN_SECRET: 'changeme', CLIENT_URL: 'https://wiki.example.com' }));
      expect(result.warnings).toEqual([]);
    });

    test('unset WS_TOKEN_SECRET is unaffected — no warning, no failure', () => {
      const result = validateEnv(makeEnv({ NODE_ENV: 'production', CLIENT_URL: 'https://wiki.example.com' }));
      expect(result.warnings).toEqual([]);
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
          // >= 32 chars: this test asserts the typo heuristic ignores known
          // names regardless of content, not the WS_TOKEN_SECRET length
          // check (covered in its own `describe` block below) — a shorter
          // value here would trip that separate check instead.
          WS_TOKEN_SECRET: 'x'.repeat(40),
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
          'REDIS_KEY_PREFIX',
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
          'IMAGE_DERIVATIVE_MAX_PIXELS',
          'IMAGE_DERIVATIVE_ADMISSION_CONCURRENCY',
          'IMAGE_DERIVATIVE_ADMISSION_TIMEOUT_MS',
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
