import { join, resolve } from 'node:path';
import Crowi from 'src/crowi';

/**
 * Constructor-level wiring for `validateEnv()` (feature-boot-env-validation,
 * item #25). `env-schema.test.ts` covers the validation logic itself in
 * isolation; this file locks down that the `Crowi` constructor actually
 * calls it exactly once and wires the result into the fields other boot
 * steps depend on (AC-2 / AC-13 / AC-16).
 *
 * Constructing `Crowi` is side-effect-free (no DB) — see
 * `api-ready-url.test.ts` — so these run without the MongoMemoryServer
 * harness.
 */

const ROOT_DIR = resolve(join(__dirname, '..', '..'));

describe('Crowi constructor env validation wiring', () => {
  it('derives baseUrl/node_env/port/redisUrl/mongoUri from validateEnv() (AC-2)', () => {
    const crowi = new Crowi(ROOT_DIR, {
      BASE_URL: 'http://localhost:4301',
      NODE_ENV: 'development',
      PORT: '4301',
      REDIS_URL: 'redis://localhost:6379',
      MONGO_URI: 'mongodb://localhost/crowi_test',
    } as unknown as NodeJS.ProcessEnv);

    expect(crowi.baseUrl).toBe('http://localhost:4301');
    expect(crowi.node_env).toBe('development');
    expect(crowi.port).toBe(4301);
    expect(crowi.redisUrl).toBe('redis://localhost:6379');
    expect(crowi.mongoUri).toBe('mongodb://localhost/crowi_test');
    // `this.env` itself stays untouched (dynamic key access must keep working).
    expect(crowi.env.PORT).toBe('4301');
  });

  it('falls back to the documented defaults when unset', () => {
    const crowi = new Crowi(ROOT_DIR, {} as unknown as NodeJS.ProcessEnv);

    expect(crowi.baseUrl).toBeNull();
    expect(crowi.node_env).toBe('production');
    expect(crowi.port).toBe(4301);
    expect(crowi.redisUrl).toBeNull();
    expect(crowi.mongoUri).toBe('mongodb://localhost/crowi');
    // CLIENT_URL unset is pre-existing warn-worthy behaviour (mail links
    // would be relative) — now surfaced through the one consolidated report
    // instead of a separate `setupMailer()` warning (AC-12).
    expect(crowi.envValidationWarnings).toEqual([expect.stringMatching(/^CLIENT_URL: is not set/)]);
  });

  it('AC-13: throws once with every invalid fail-severity variable, not just the first', () => {
    expect(
      () =>
        new Crowi(ROOT_DIR, {
          PORT: 'not-a-number',
          MONGO_URI: 'postgres://localhost/crowi',
        } as unknown as NodeJS.ProcessEnv),
    ).toThrow(/PORT[\s\S]*MONGO_URI|MONGO_URI[\s\S]*PORT/);
  });

  it('stashes warn-severity findings on the instance instead of throwing (AC-7/8/9)', () => {
    const crowi = new Crowi(ROOT_DIR, {
      CLIENT_URL: 'not-an-absolute-url',
      NODE_ENV: 'staging',
    } as unknown as NodeJS.ProcessEnv);

    expect(crowi.envValidationWarnings.some((w) => w.startsWith('CLIENT_URL:'))).toBe(true);
    expect(crowi.envValidationWarnings.some((w) => w.startsWith('NODE_ENV:'))).toBe(true);
  });

  it('AC-6 regression: a whitespace-only CROWI_ENCRYPTION_KEY fails boot, matching the pre-existing setupEncryption() `if (!raw)` check (a whitespace string is truthy, so the old code fell through to the byte-length check and threw — not the "unset" branch)', () => {
    expect(
      () =>
        new Crowi(ROOT_DIR, {
          CROWI_ENCRYPTION_KEY: '   ',
          CLIENT_URL: 'https://wiki.example.com',
        } as unknown as NodeJS.ProcessEnv),
    ).toThrow(/CROWI_ENCRYPTION_KEY/);
  });

  it('AC-16: initForCli() flushes the constructor-computed warnings (no second validateEnv() pass)', async () => {
    const crowi = new Crowi(ROOT_DIR, {
      NODE_ENV: 'staging', // recognised var, invalid value → warn-severity
      CLIENT_URL: 'http://localhost:4301', // set so this env only produces the one NODE_ENV warning below
    } as unknown as NodeJS.ProcessEnv);

    expect(crowi.envValidationWarnings.some((w) => w.startsWith('NODE_ENV:'))).toBe(true);

    // Stub every other initForCli() step (DB / plugins / renderer) so this
    // test exercises only the env-validation flush — `validateEnv()` itself
    // already ran once in the constructor above; there is no second call
    // site to re-verify here.
    jest.spyOn(crowi, 'setupEncryption').mockImplementation(() => undefined);
    jest.spyOn(crowi, 'setupDatabase').mockResolvedValue(undefined);
    jest.spyOn(crowi, 'setupModels').mockResolvedValue(undefined);
    jest.spyOn(crowi, 'setupConfig').mockResolvedValue(undefined);
    jest.spyOn(crowi, 'setupRenderer').mockImplementation(() => undefined);
    jest.spyOn(crowi, 'setupPlugins').mockResolvedValue(undefined);

    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      await crowi.initForCli();
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('[crowi] env validation: 1 warning(s)'));
      expect(warnSpy.mock.calls.some(([line]) => typeof line === 'string' && line.includes('NODE_ENV:'))).toBe(true);
    } finally {
      warnSpy.mockRestore();
    }
  });
});
