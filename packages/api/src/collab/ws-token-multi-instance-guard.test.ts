/**
 * editor-preview-reliability §4 / E1 — boot guard for a non-shared
 * `WS_TOKEN_SECRET` in a DECLARED multi-instance deployment.
 *
 * This is a pure unit test of `assertWsTokenSecretForMultiInstance`; it
 * does NOT boot the full api (the heavy `src/test/setup` path), so we
 * stub `crowi` (the guard no longer reads any field off it) and toggle
 * `WS_TOKEN_SECRET` / `CROWI_MULTI_INSTANCE` per case.
 *
 * E1: the multi-instance signal is the EXPLICIT `CROWI_MULTI_INSTANCE`
 * declaration, NOT `REDIS_URL` presence (Redis is also used by
 * single-replica deployments). And a known placeholder secret is rejected
 * so a forgotten template value can never satisfy the guard.
 *
 * Note: `assertWsTokenSecretForMultiInstance` imports `attach.ts`, whose
 * module graph reaches `@crowi/collab` — we mock that here so the ESM-only
 * `crossws` transitive dep never loads under Jest's CJS loader.
 */
jest.mock('@crowi/collab', () => ({ createCollabServer: jest.fn() }));

import type Crowi from 'src/crowi';
import { assertWsTokenSecretForMultiInstance } from './attach';

// The guard no longer reads any field off crowi; an empty stub suffices.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const fakeCrowi = (): Crowi => ({}) as any;

describe('assertWsTokenSecretForMultiInstance (editor-preview-reliability §4 / E1)', () => {
  const ORIGINAL_SECRET = process.env.WS_TOKEN_SECRET;
  const ORIGINAL_MULTI = process.env.CROWI_MULTI_INSTANCE;

  const restore = (key: string, original: string | undefined): void => {
    if (original === undefined) delete process.env[key];
    else process.env[key] = original;
  };

  afterEach(() => {
    restore('WS_TOKEN_SECRET', ORIGINAL_SECRET);
    restore('CROWI_MULTI_INSTANCE', ORIGINAL_MULTI);
    jest.restoreAllMocks();
  });

  it('passes when a real WS_TOKEN_SECRET is set, regardless of the multi-instance declaration', () => {
    process.env.WS_TOKEN_SECRET = 'a-stable-shared-secret';
    process.env.CROWI_MULTI_INSTANCE = '3';
    expect(() => assertWsTokenSecretForMultiInstance(fakeCrowi())).not.toThrow();
    delete process.env.CROWI_MULTI_INSTANCE;
    expect(() => assertWsTokenSecretForMultiInstance(fakeCrowi())).not.toThrow();
  });

  it('passes (single-instance) when no secret AND no multi-instance declaration — even with Redis configured', () => {
    delete process.env.WS_TOKEN_SECRET;
    delete process.env.CROWI_MULTI_INSTANCE;
    // REDIS_URL presence must NOT trigger the guard on its own (E1).
    process.env.REDIS_URL = 'redis://localhost:6379';
    expect(() => assertWsTokenSecretForMultiInstance(fakeCrowi())).not.toThrow();
  });

  it('throws (boot-fail) when multi-instance is declared AND no secret is set', () => {
    delete process.env.WS_TOKEN_SECRET;
    process.env.CROWI_MULTI_INSTANCE = 'true';
    expect(() => assertWsTokenSecretForMultiInstance(fakeCrowi())).toThrow(
      /CROWI_MULTI_INSTANCE declares a multi-instance deployment but WS_TOKEN_SECRET is not set/,
    );
  });

  it('throws when multi-instance is declared via a replica count >= 2', () => {
    delete process.env.WS_TOKEN_SECRET;
    process.env.CROWI_MULTI_INSTANCE = '4';
    expect(() => assertWsTokenSecretForMultiInstance(fakeCrowi())).toThrow(/multi-instance/);
  });

  it('E1: a known placeholder secret is REJECTED by the guard (treated as not configured)', () => {
    process.env.CROWI_MULTI_INSTANCE = 'true';
    // The exact dev-template placeholder a forgotten `.env` copy might carry.
    process.env.WS_TOKEN_SECRET = 'dev-only-ws-token-secret-replace-in-production-0000=';
    expect(() => assertWsTokenSecretForMultiInstance(fakeCrowi())).toThrow(/WS_TOKEN_SECRET is not set/);
  });

  it('does not throw for a placeholder secret when single-instance (the random fallback covers it)', () => {
    delete process.env.CROWI_MULTI_INSTANCE;
    process.env.WS_TOKEN_SECRET = 'changeme';
    expect(() => assertWsTokenSecretForMultiInstance(fakeCrowi())).not.toThrow();
  });
});
