/**
 * Regression guard for the REMOVAL of the multi-instance-only
 * `WS_TOKEN_SECRET` boot guard (`assertWsTokenSecretForMultiInstance` /
 * `isWsTokenSecretFromEnv`, both deleted from `collab/attach.ts` /
 * `util/ws-token.ts`).
 *
 * `SECRET_TOKEN`'s required validation (`util/env-schema.ts`) is now
 * unconditional: a single-instance deployment with no secret configured
 * boot-fails exactly like a declared multi-instance one used to (and still
 * does) — `CROWI_MULTI_INSTANCE` has no bearing on the outcome either way.
 * This file is kept (rather than deleted) so a future re-introduction of a
 * multi-instance-only signing-secret carve-out shows up as a diff against
 * an existing regression suite, not a silent gap. It intentionally does
 * NOT import from `./attach` or `./ws-token` — those removed symbols are
 * not a grounding anchor for this file going forward.
 */

import { validateEnv } from 'src/util/env-schema';

function makeEnv(overrides: Record<string, string | undefined> = {}): NodeJS.ProcessEnv {
  return overrides as unknown as NodeJS.ProcessEnv;
}

describe('SECRET_TOKEN required validation is independent of CROWI_MULTI_INSTANCE (replaces the removed multi-instance-only WS_TOKEN_SECRET guard)', () => {
  test.each([
    undefined,
    'false',
    '0',
    'true',
    '1',
    '2',
    '10',
  ])('boot fails when SECRET_TOKEN/WS_TOKEN_SECRET are both unset, regardless of CROWI_MULTI_INSTANCE=%s', (multi) => {
    expect(() => validateEnv(makeEnv({ CROWI_MULTI_INSTANCE: multi }))).toThrow(/SECRET_TOKEN/);
  });

  test.each([
    undefined,
    'false',
    'true',
    '4',
  ])('a valid SECRET_TOKEN passes regardless of CROWI_MULTI_INSTANCE=%s (single- and multi-instance alike)', (multi) => {
    expect(() => validateEnv(makeEnv({ SECRET_TOKEN: 'a'.repeat(32), CROWI_MULTI_INSTANCE: multi }))).not.toThrow();
  });

  test('a known placeholder still fails even when CROWI_MULTI_INSTANCE is unset — single-instance is no longer exempt', () => {
    expect(() => validateEnv(makeEnv({ SECRET_TOKEN: 'changeme' }))).toThrow(/SECRET_TOKEN/);
  });

  test("REDIS_URL presence alone (no CROWI_MULTI_INSTANCE declaration) does not change the outcome either way — the removed guard's own E1 fix is preserved by SECRET_TOKEN simply being unconditional now", () => {
    expect(() => validateEnv(makeEnv({ SECRET_TOKEN: 'a'.repeat(32), REDIS_URL: 'redis://localhost:6379', REDIS_KEY_PREFIX: 'krswd' }))).not.toThrow();
    expect(() => validateEnv(makeEnv({ REDIS_URL: 'redis://localhost:6379', REDIS_KEY_PREFIX: 'krswd' }))).toThrow(/SECRET_TOKEN/);
  });

  test('a valid legacy WS_TOKEN_SECRET alone also passes regardless of CROWI_MULTI_INSTANCE', () => {
    expect(() => validateEnv(makeEnv({ WS_TOKEN_SECRET: 'a'.repeat(32), CROWI_MULTI_INSTANCE: 'true' }))).not.toThrow();
  });

  test('a declared multi-instance deployment (replica count >= 2) with a valid secret still passes — CROWI_MULTI_INSTANCE remains a topology signal for Redis/collab, not a signing-secret gate', () => {
    expect(() => validateEnv(makeEnv({ SECRET_TOKEN: 'a'.repeat(32), CROWI_MULTI_INSTANCE: '4' }))).not.toThrow();
  });
});
