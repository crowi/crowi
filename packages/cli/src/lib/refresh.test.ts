import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ADHOC_ALIAS, loadConfig, type Profile, type ProfileTokens, upsertProfile } from './config';
import type { RefreshHook } from './http';
import { setRefreshHook } from './http';
import { refreshTokens } from './oauth';
import { installRefreshHook } from './refresh';

// `installRefreshHook` only ever hands its hook to `setRefreshHook` — there
// is no public getter, so we mock `./http` to capture the hook function and
// invoke it directly, exactly as the real 401-retry path in `http.ts` would.
jest.mock('./http', () => ({ setRefreshHook: jest.fn() }));
jest.mock('./oauth', () => ({ refreshTokens: jest.fn() }));

const mockedSetRefreshHook = setRefreshHook as jest.MockedFunction<typeof setRefreshHook>;
const mockedRefreshTokens = refreshTokens as jest.MockedFunction<typeof refreshTokens>;

/**
 * feature-oauth-refresh-rotation-grace §D-3 — the CLI's recovery path for
 * the loser of a concurrent refresh race: when `refreshTokens` fails,
 * `performRefresh` re-reads the persisted profile (bounded: a few attempts
 * a short delay apart, closing the gap where the winner hasn't finished its
 * own local disk write yet) and, if the stored refresh token differs from
 * the one it just presented, retries exactly once with the winner's token
 * (AC-8/AC-9/AC-10). Real timers would add ~300ms per case exercising the
 * unchanged-token path (3 attempts, 2 real 150ms delays) — fake timers keep
 * the suite fast while still exercising the actual bounded-wait code path.
 */
describe('installRefreshHook', () => {
  let tmpRoot: string;
  const ORIGINAL_XDG = process.env.XDG_CONFIG_HOME;
  let hook: RefreshHook;

  beforeEach(() => {
    jest.useFakeTimers();
    tmpRoot = mkdtempSync(join(tmpdir(), 'crowi-cli-refresh-'));
    process.env.XDG_CONFIG_HOME = tmpRoot;
    delete process.env.CROWI_PROFILE;
    mockedSetRefreshHook.mockClear();
    mockedRefreshTokens.mockReset();
    installRefreshHook();
    hook = mockedSetRefreshHook.mock.calls[0][0] as RefreshHook;
  });

  afterEach(() => {
    jest.useRealTimers();
    rmSync(tmpRoot, { recursive: true, force: true });
    if (ORIGINAL_XDG === undefined) {
      delete process.env.XDG_CONFIG_HOME;
    } else {
      process.env.XDG_CONFIG_HOME = ORIGINAL_XDG;
    }
  });

  /** Runs `hook(profile)` while draining every pending re-read delay, so a case doesn't need to know in advance how many attempts it will take. */
  const runHook = async (profile: Profile): Promise<string | undefined> => {
    const promise = hook(profile);
    // 2 possible inter-attempt delays (REREAD_ATTEMPTS=3) — advancing past
    // both is a no-op once the loop has already broken out early.
    await jest.advanceTimersByTimeAsync(150);
    await jest.advanceTimersByTimeAsync(150);
    return promise;
  };

  const sampleProfile = (overrides: Partial<Profile> = {}): Profile => ({
    alias: 'work',
    endpoint: 'https://wiki.example.com',
    oauth: { tokenEndpoint: 'https://wiki.example.com/api/oauth/token' },
    tokens: { accessToken: 'stale-access', refreshToken: 'crowi_rt_A' },
    ...overrides,
  });

  const rotatedTokens = (overrides: Partial<ProfileTokens> = {}): ProfileTokens => ({
    accessToken: 'fresh-access',
    refreshToken: 'crowi_rt_next',
    expiresAt: Date.now() + 3_600_000,
    scope: 'pages:read',
    ...overrides,
  });

  it('retries once with the stored refresh token when it differs from the one presented, and persists the result (AC-8)', async () => {
    const presented = sampleProfile();
    upsertProfile(presented);
    // Simulate a winner that already rotated A -> B on disk before this call runs.
    upsertProfile({ ...presented, tokens: { accessToken: 'winner-access', refreshToken: 'crowi_rt_B' } });

    mockedRefreshTokens.mockResolvedValueOnce(undefined); // first attempt (A) is rejected
    const retriedTokens = rotatedTokens({ refreshToken: 'crowi_rt_C' });
    mockedRefreshTokens.mockResolvedValueOnce(retriedTokens); // retry (B) succeeds

    const result = await hook(presented);

    expect(result).toBe(retriedTokens.accessToken);
    expect(mockedRefreshTokens).toHaveBeenCalledTimes(2);
    expect(mockedRefreshTokens).toHaveBeenNthCalledWith(1, presented.oauth?.tokenEndpoint, 'crowi_rt_A');
    expect(mockedRefreshTokens).toHaveBeenNthCalledWith(2, presented.oauth?.tokenEndpoint, 'crowi_rt_B');
  });

  it('does not retry when the stored refresh token is unchanged — surfaces the failure as undefined (AC-9)', async () => {
    const presented = sampleProfile();
    upsertProfile(presented);
    mockedRefreshTokens.mockResolvedValueOnce(undefined);

    const result = await runHook(presented);

    expect(result).toBeUndefined();
    expect(mockedRefreshTokens).toHaveBeenCalledTimes(1);
  });

  it('re-reads the persisted profile across the bounded window and recovers once the winner catches up (AC-8, D-3 bounded re-read)', async () => {
    const presented = sampleProfile();
    upsertProfile(presented);
    mockedRefreshTokens.mockResolvedValueOnce(undefined); // first attempt (A) is rejected

    const hookPromise = hook(presented);

    // Neither the first (immediate) check nor the one after the first delay
    // sees the winner's write yet — it lands only after the second delay.
    await Promise.resolve();
    await jest.advanceTimersByTimeAsync(150);
    upsertProfile({ ...presented, tokens: { accessToken: 'winner-access', refreshToken: 'crowi_rt_B' } });
    const retriedTokens = rotatedTokens({ refreshToken: 'crowi_rt_C' });
    mockedRefreshTokens.mockResolvedValueOnce(retriedTokens);
    await jest.advanceTimersByTimeAsync(150);

    const result = await hookPromise;

    expect(result).toBe(retriedTokens.accessToken);
    expect(mockedRefreshTokens).toHaveBeenCalledTimes(2);
    expect(mockedRefreshTokens).toHaveBeenNthCalledWith(2, presented.oauth?.tokenEndpoint, 'crowi_rt_B');
  });

  it('does not clobber unrelated profile fields updated by a third process during the retry round-trip', async () => {
    // The retry's network round-trip (the second `refreshTokens` call) takes
    // real time, unlike the synchronous read-then-write in `persistIfNamed`'s
    // success path. A naive fix would capture the profile snapshot BEFORE
    // that round-trip and write it back AFTER — silently reverting whatever
    // an unrelated third process (e.g. a concurrent capability refresh)
    // wrote to the same profile file in between.
    const presented = sampleProfile();
    upsertProfile(presented);
    upsertProfile({ ...presented, tokens: { accessToken: 'winner-access', refreshToken: 'crowi_rt_B' }, capabilities: ['pages:read'] });

    mockedRefreshTokens.mockResolvedValueOnce(undefined); // first attempt (A) is rejected
    const retriedTokens = rotatedTokens({ refreshToken: 'crowi_rt_C' });
    mockedRefreshTokens.mockImplementationOnce(async () => {
      // Simulate a third process updating unrelated state while THIS retry
      // request is in flight.
      upsertProfile({ ...presented, tokens: { accessToken: 'winner-access', refreshToken: 'crowi_rt_B' }, capabilities: ['pages:read', 'pages:write'] });
      return retriedTokens;
    });

    const result = await hook(presented);

    expect(result).toBe(retriedTokens.accessToken);
    const config = loadConfig();
    expect(config.profiles.work?.tokens?.refreshToken).toBe('crowi_rt_C');
    expect(config.profiles.work?.capabilities).toEqual(['pages:read', 'pages:write']);
  });

  it('retries at most once, even when the retry also fails (AC-10)', async () => {
    const presented = sampleProfile();
    upsertProfile(presented);
    upsertProfile({ ...presented, tokens: { accessToken: 'winner-access', refreshToken: 'crowi_rt_B' } });
    mockedRefreshTokens.mockResolvedValue(undefined); // every attempt fails

    const result = await hook(presented);

    expect(result).toBeUndefined();
    expect(mockedRefreshTokens).toHaveBeenCalledTimes(2);
  });

  it('never attempts the re-read retry for an ad-hoc (never-persisted) profile', async () => {
    const presented = sampleProfile({ alias: ADHOC_ALIAS });
    mockedRefreshTokens.mockResolvedValueOnce(undefined);

    const result = await hook(presented);

    expect(result).toBeUndefined();
    expect(mockedRefreshTokens).toHaveBeenCalledTimes(1);
  });

  it('succeeds without a retry when the first attempt rotates cleanly', async () => {
    const presented = sampleProfile();
    upsertProfile(presented);
    const tokens = rotatedTokens();
    mockedRefreshTokens.mockResolvedValueOnce(tokens);

    const result = await hook(presented);

    expect(result).toBe(tokens.accessToken);
    expect(mockedRefreshTokens).toHaveBeenCalledTimes(1);
  });
});
