/**
 * A stable, valid `SECRET_TOKEN` (≥32 chars, non-placeholder) for tests that
 * construct `Crowi` directly and therefore need to satisfy `util/env-schema.ts`'s
 * boot-time validation without relying on ambient seeding.
 */
export const TEST_SECRET_TOKEN = 'test-signing-secret-base64-32bytes=';

/**
 * Save/restore both `SECRET_TOKEN` and `WS_TOKEN_SECRET` around a block of
 * test code that needs to control the unified signing secret (or force the
 * per-process random fallback by unsetting both) — never leaks a value into
 * a later test/file sharing the same jest worker. Shared by
 * `util/signed-token-factory.test.ts`, `util/signing-secret-integration.test.ts`,
 * `util/mail-token.test.ts`, and `util/notifications-token.test.ts`.
 */
export function withSecretTokenEnv(overrides: { SECRET_TOKEN?: string; WS_TOKEN_SECRET?: string }, run: () => void): void {
  const original = { SECRET_TOKEN: process.env.SECRET_TOKEN, WS_TOKEN_SECRET: process.env.WS_TOKEN_SECRET };
  try {
    for (const key of ['SECRET_TOKEN', 'WS_TOKEN_SECRET'] as const) {
      if (overrides[key] === undefined) delete process.env[key];
      else process.env[key] = overrides[key];
    }
    run();
  } finally {
    for (const key of ['SECRET_TOKEN', 'WS_TOKEN_SECRET'] as const) {
      if (original[key] === undefined) delete process.env[key];
      else process.env[key] = original[key];
    }
  }
}
