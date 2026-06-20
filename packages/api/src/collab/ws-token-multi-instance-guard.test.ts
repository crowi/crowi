/**
 * editor-preview-reliability §4 — boot guard for a non-shared
 * `WS_TOKEN_SECRET` in a multi-instance-shaped (REDIS_URL set)
 * deployment.
 *
 * This is a pure unit test of `assertWsTokenSecretForMultiInstance`; it
 * does NOT boot the full api (the heavy `src/test/setup` path), so we
 * stub the `crowi` shape down to the single `redis` field the guard
 * reads, and toggle `WS_TOKEN_SECRET` / the opt-out env per case.
 *
 * Note: `assertWsTokenSecretForMultiInstance` imports `attach.ts`,
 * whose module graph reaches `@crowi/collab` — we mock that here so the
 * ESM-only `crossws` transitive dep never loads under Jest's CJS loader
 * (same reason `attach.test.ts` mocks it).
 */
jest.mock('@crowi/collab', () => ({ createCollabServer: jest.fn() }));

import type Crowi from 'src/crowi';
import { assertWsTokenSecretForMultiInstance } from './attach';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const fakeCrowi = (redis: unknown): Crowi => ({ redis }) as any;

describe('assertWsTokenSecretForMultiInstance (editor-preview-reliability §4)', () => {
  const ORIGINAL_SECRET = process.env.WS_TOKEN_SECRET;
  const ORIGINAL_OPT_OUT = process.env.CROWI_ALLOW_EPHEMERAL_WS_TOKEN_SECRET;

  afterEach(() => {
    if (ORIGINAL_SECRET === undefined) delete process.env.WS_TOKEN_SECRET;
    else process.env.WS_TOKEN_SECRET = ORIGINAL_SECRET;
    if (ORIGINAL_OPT_OUT === undefined) delete process.env.CROWI_ALLOW_EPHEMERAL_WS_TOKEN_SECRET;
    else process.env.CROWI_ALLOW_EPHEMERAL_WS_TOKEN_SECRET = ORIGINAL_OPT_OUT;
    jest.restoreAllMocks();
  });

  it('passes when WS_TOKEN_SECRET is set, regardless of Redis', () => {
    process.env.WS_TOKEN_SECRET = 'a-stable-shared-secret';
    delete process.env.CROWI_ALLOW_EPHEMERAL_WS_TOKEN_SECRET;
    expect(() => assertWsTokenSecretForMultiInstance(fakeCrowi({}))).not.toThrow();
    expect(() => assertWsTokenSecretForMultiInstance(fakeCrowi(null))).not.toThrow();
  });

  it('passes (single-instance dev) when no secret AND no Redis', () => {
    delete process.env.WS_TOKEN_SECRET;
    delete process.env.CROWI_ALLOW_EPHEMERAL_WS_TOKEN_SECRET;
    expect(() => assertWsTokenSecretForMultiInstance(fakeCrowi(null))).not.toThrow();
  });

  it('throws (boot-fail) when no secret AND Redis is configured (multi-instance shape)', () => {
    delete process.env.WS_TOKEN_SECRET;
    delete process.env.CROWI_ALLOW_EPHEMERAL_WS_TOKEN_SECRET;
    expect(() => assertWsTokenSecretForMultiInstance(fakeCrowi({}))).toThrow(/WS_TOKEN_SECRET is not set while REDIS_URL is configured/);
  });

  it('downgrades to a warning when the explicit opt-out env is set', () => {
    delete process.env.WS_TOKEN_SECRET;
    process.env.CROWI_ALLOW_EPHEMERAL_WS_TOKEN_SECRET = '1';
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    expect(() => assertWsTokenSecretForMultiInstance(fakeCrowi({}))).not.toThrow();
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('ephemeral per-process secret'));
  });
});
