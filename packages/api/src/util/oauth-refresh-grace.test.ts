/**
 * AC-5 / AC-6 — the OAuth refresh reuse grace window.
 *
 * `OAUTH_REFRESH_REUSE_GRACE_MS` is resolved once at module import time
 * (matching the adjacent `ACCESS_TOKEN_TTL_SEC` pattern in
 * `hono/handlers/oauth.ts`), so exercising different env-var values needs a
 * fresh module instance per case — `jest.resetModules()` + a dynamic
 * `require` inside each test, mirroring `plugin/mail-smtp.test.ts`.
 */

const ENV_VAR = 'OAUTH_REFRESH_REUSE_GRACE_MS';
const ORIGINAL = process.env[ENV_VAR];

type Module = typeof import('./oauth-refresh-grace');

function loadWithEnv(value: string | undefined): Module {
  jest.resetModules();
  if (value === undefined) {
    delete process.env[ENV_VAR];
  } else {
    process.env[ENV_VAR] = value;
  }
  // eslint-disable-next-line @typescript-eslint/no-var-requires, @typescript-eslint/no-require-imports
  return require('./oauth-refresh-grace') as Module;
}

afterEach(() => {
  if (ORIGINAL === undefined) {
    delete process.env[ENV_VAR];
  } else {
    process.env[ENV_VAR] = ORIGINAL;
  }
  jest.resetModules();
});

describe('OAUTH_REFRESH_REUSE_GRACE_MS', () => {
  it('defaults to 60,000 ms when unset (AC-6)', () => {
    const mod = loadWithEnv(undefined);
    expect(mod.OAUTH_REFRESH_REUSE_GRACE_MS).toBe(60_000);
  });

  it('falls back to the default for a non-numeric value (AC-6)', () => {
    const mod = loadWithEnv('not-a-number');
    expect(mod.OAUTH_REFRESH_REUSE_GRACE_MS).toBe(60_000);
  });

  it('falls back to the default for a negative value', () => {
    const mod = loadWithEnv('-1000');
    expect(mod.OAUTH_REFRESH_REUSE_GRACE_MS).toBe(60_000);
  });

  it('falls back to the default for an empty string', () => {
    const mod = loadWithEnv('');
    expect(mod.OAUTH_REFRESH_REUSE_GRACE_MS).toBe(60_000);
  });

  it('falls back to the default for exponential notation instead of silently truncating it (AC-6)', () => {
    // Number.parseInt('1e3', 10) would silently truncate this to 1 — the
    // user meant 1000. Reject rather than mis-parse.
    const mod = loadWithEnv('1e3');
    expect(mod.OAUTH_REFRESH_REUSE_GRACE_MS).toBe(60_000);
  });

  it('falls back to the default for a value with a trailing unit instead of silently truncating it (AC-6)', () => {
    // Number.parseInt('60000ms', 10) would silently accept the leading
    // digits — reject the whole malformed literal instead.
    const mod = loadWithEnv('60000ms');
    expect(mod.OAUTH_REFRESH_REUSE_GRACE_MS).toBe(60_000);
  });

  it('falls back to the default for a fractional value instead of coercing it to -0 (AC-6)', () => {
    // Number.parseInt('-0.5', 10) === -0, which is not < 0, so a naive
    // negative check would let it slip through as "0" (grace disabled) —
    // the opposite of the documented default-fallback behaviour.
    const mod = loadWithEnv('-0.5');
    expect(mod.OAUTH_REFRESH_REUSE_GRACE_MS).toBe(60_000);
  });

  it('honours an explicit override', () => {
    const mod = loadWithEnv('5000');
    expect(mod.OAUTH_REFRESH_REUSE_GRACE_MS).toBe(5000);
  });

  it('accepts 0 verbatim — disables the grace rather than falling back to the default (AC-5)', () => {
    const mod = loadWithEnv('0');
    expect(mod.OAUTH_REFRESH_REUSE_GRACE_MS).toBe(0);
  });

  it('clamps a value above the sanity ceiling', () => {
    const mod = loadWithEnv('99999999');
    expect(mod.OAUTH_REFRESH_REUSE_GRACE_MS).toBe(5 * 60 * 1000);
  });
});

describe('isWithinReuseGrace', () => {
  it('is true just inside the boundary and false just outside it', () => {
    const mod = loadWithEnv('60000');
    const now = new Date('2026-01-01T00:01:00.000Z');
    const justInside = new Date(now.getTime() - 59_999);
    const atBoundary = new Date(now.getTime() - 60_000);
    const justOutside = new Date(now.getTime() - 60_001);

    expect(mod.isWithinReuseGrace(justInside, now)).toBe(true);
    // Strict `<`: elapsed === graceMs is NOT within grace.
    expect(mod.isWithinReuseGrace(atBoundary, now)).toBe(false);
    expect(mod.isWithinReuseGrace(justOutside, now)).toBe(false);
  });

  it('is always false when the grace is disabled (0), even for a same-millisecond replay (AC-5)', () => {
    const mod = loadWithEnv('0');
    const now = new Date('2026-01-01T00:01:00.000Z');
    expect(mod.isWithinReuseGrace(now, now)).toBe(false);
    expect(mod.isWithinReuseGrace(new Date(now.getTime() - 1), now)).toBe(false);
  });

  it('is always false when the grace is disabled (0), even if clock skew makes revokedAt appear future-dated (AC-5)', () => {
    // A future revokedAt (checking replica's clock lags the stamping
    // replica's) makes the raw elapsed negative. Without clamping to 0,
    // `-5000 < 0` would be true for ANY positive grace and would also make
    // grace=0 look ambiguous; the clamp keeps 0 unconditionally false.
    const mod = loadWithEnv('0');
    const now = new Date('2026-01-01T00:01:00.000Z');
    const futureRevokedAt = new Date(now.getTime() + 5_000);
    expect(mod.isWithinReuseGrace(futureRevokedAt, now)).toBe(false);
  });

  it('treats a future-dated revokedAt (clock skew) as elapsed=0, not negative, for a positive grace', () => {
    const mod = loadWithEnv('60000');
    const now = new Date('2026-01-01T00:01:00.000Z');
    const futureRevokedAt = new Date(now.getTime() + 5_000);
    expect(mod.isWithinReuseGrace(futureRevokedAt, now)).toBe(true);
  });

  it('defaults `now` to the current time', () => {
    const mod = loadWithEnv('60000');
    expect(mod.isWithinReuseGrace(new Date())).toBe(true);
    expect(mod.isWithinReuseGrace(new Date(Date.now() - 120_000))).toBe(false);
  });
});
