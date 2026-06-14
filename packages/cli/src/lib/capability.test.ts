import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ADHOC_ALIAS, loadConfig, type Profile, upsertProfile } from './config';
import { effectiveCapabilities, fetchAppInfo, hasCapability, maybeWarnVersionSkew, STATIC_CAPABILITIES, warnVersionSkew } from './capability';

describe('capability detection', () => {
  it('treats the static baseline as always present, even with no advertised list', () => {
    const info = {};
    for (const cap of STATIC_CAPABILITIES) {
      expect(hasCapability(info, cap)).toBe(true);
    }
  });

  it('reports a dynamic capability only when the server advertises it', () => {
    expect(hasCapability({}, 'search')).toBe(false);
    expect(hasCapability({ capabilities: ['search'] }, 'search')).toBe(true);
  });

  it('unions the advertised list with the static baseline', () => {
    const set = effectiveCapabilities({ capabilities: ['search', 'collab'] });
    expect(set.has('search')).toBe(true);
    expect(set.has('collab')).toBe(true);
    // Static baseline still present.
    expect(set.has('pages')).toBe(true);
    expect(set.has('comments')).toBe(true);
  });

  it('does not invent capabilities the server omits', () => {
    expect(hasCapability({ capabilities: ['pages'] }, 'search')).toBe(false);
  });
});

describe('warnVersionSkew (WARN-ONLY policy)', () => {
  let stderr: jest.SpyInstance;

  beforeEach(() => {
    stderr = jest.spyOn(process.stderr, 'write').mockImplementation(() => true);
  });

  afterEach(() => {
    stderr.mockRestore();
  });

  it('warns when the server apiVersion differs from the CLI target', () => {
    warnVersionSkew({ apiVersion: 'v3' });
    expect(stderr).toHaveBeenCalledTimes(1);
    expect(String(stderr.mock.calls[0][0])).toContain('v3');
  });

  it('stays silent when the apiVersion matches', () => {
    warnVersionSkew({ apiVersion: 'v2' });
    expect(stderr).not.toHaveBeenCalled();
  });

  it('stays silent for an old server that omits apiVersion', () => {
    warnVersionSkew({});
    warnVersionSkew({ version: '2.0.0' });
    expect(stderr).not.toHaveBeenCalled();
  });
});

/**
 * `maybeWarnVersionSkew` is the Phase 1 wiring: a best-effort probe run from
 * the commander `preSubcommand` hook so the skew note is live for the whole
 * authenticated core surface (not just the Phase 2 commands that call
 * `ensureCapability`). It must (a) warn when a resolvable, token-bearing
 * profile sits on a skewed server, (b) make NO request when no usable
 * profile/token resolves, and (c) never throw on a failed probe.
 */
describe('maybeWarnVersionSkew (Phase 1 preSubcommand probe)', () => {
  let tmpRoot: string;
  let stderr: jest.SpyInstance;
  let fetchMock: jest.Mock<Promise<Response>, [string, RequestInit]>;
  const originalFetch = global.fetch;
  const ORIGINAL_XDG = process.env.XDG_CONFIG_HOME;

  function jsonResponse(status: number, body: unknown): Response {
    return {
      ok: status >= 200 && status < 300,
      status,
      text: async () => (body === undefined ? '' : JSON.stringify(body)),
    } as Response;
  }

  beforeEach(() => {
    // Isolate the on-disk config so the probe's TTL-cache write
    // (`upsertProfile`) never touches the developer's ~/.config/crowi.
    tmpRoot = mkdtempSync(join(tmpdir(), 'crowi-cli-skew-'));
    process.env.XDG_CONFIG_HOME = tmpRoot;
    delete process.env.CROWI_PROFILE;
    delete process.env.CROWI_URL;
    delete process.env.CROWI_TOKEN;
    stderr = jest.spyOn(process.stderr, 'write').mockImplementation(() => true);
    fetchMock = jest.fn();
    global.fetch = fetchMock as unknown as typeof fetch;
  });

  afterEach(() => {
    rmSync(tmpRoot, { recursive: true, force: true });
    if (ORIGINAL_XDG === undefined) {
      delete process.env.XDG_CONFIG_HOME;
    } else {
      process.env.XDG_CONFIG_HOME = ORIGINAL_XDG;
    }
    stderr.mockRestore();
    global.fetch = originalFetch;
  });

  it('warns when an ad-hoc profile sits on a server with a different apiVersion', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { title: 'Wiki', apiVersion: 'v3' }));
    await maybeWarnVersionSkew({ url: 'https://wiki.example.com', token: 'pat-1' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(stderr).toHaveBeenCalledTimes(1);
    expect(String(stderr.mock.calls[0][0])).toContain('v3');
  });

  it('stays silent when the server apiVersion matches the CLI target', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { title: 'Wiki', apiVersion: 'v2' }));
    await maybeWarnVersionSkew({ url: 'https://wiki.example.com', token: 'pat-1' });
    expect(stderr).not.toHaveBeenCalled();
  });

  it('makes no request and stays silent when no usable token resolves', async () => {
    // No --url/--token, no env, no stored profile → resolveProfile returns
    // undefined; the command itself surfaces the "not signed in" error.
    await maybeWarnVersionSkew({});
    expect(fetchMock).not.toHaveBeenCalled();
    expect(stderr).not.toHaveBeenCalled();
  });

  it('swallows a failed probe (network error) without throwing or warning', async () => {
    fetchMock.mockRejectedValueOnce(new Error('ECONNREFUSED'));
    await expect(maybeWarnVersionSkew({ url: 'https://down.example.com', token: 'pat-1' })).resolves.toBeUndefined();
    expect(stderr).not.toHaveBeenCalled();
  });

  it('persists apiVersion and still warns on a TTL-fresh cache HIT (no second fetch)', async () => {
    // Seed a stored profile and let the FIRST fetchAppInfo populate the cache.
    upsertProfile({ alias: 'work', endpoint: 'https://wiki.example.com', tokens: { accessToken: 'pat-1' } });
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { title: 'Wiki', apiVersion: 'v3' }));
    await maybeWarnVersionSkew({ profile: 'work' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(stderr).toHaveBeenCalledTimes(1);

    // Second invocation: the cache is fresh, so NO new fetch — but the cached
    // apiVersion must still drive the skew warning (the bug being fixed: the
    // cache-hit branch previously returned apiVersion: undefined).
    stderr.mockClear();
    await maybeWarnVersionSkew({ profile: 'work' });
    expect(fetchMock).toHaveBeenCalledTimes(1); // unchanged — served from cache
    expect(stderr).toHaveBeenCalledTimes(1);
    expect(String(stderr.mock.calls[0][0])).toContain('v3');
  });

  it('returns the cached apiVersion from fetchAppInfo on a fresh cache hit', async () => {
    upsertProfile({
      alias: 'cached',
      endpoint: 'https://wiki.example.com',
      tokens: { accessToken: 'pat-1' },
      apiVersion: 'v3',
      version: '2.1.0',
      capabilitiesFetchedAt: Date.now(),
    });
    const { loadConfig } = await import('./config');
    const profile = loadConfig().profiles.cached;
    const info = await fetchAppInfo(profile);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(info.apiVersion).toBe('v3');
  });
});

/**
 * fetchAppInfo's capability-cache WRITE must:
 *  - NEVER persist for an ad-hoc (`--url`/`--token`) profile (a one-shot PAT
 *    must not reach contexts.json), and
 *  - for a NAMED profile, write ONLY the cache-only fields onto the STORED
 *    profile (re-read), so a token rotation persisted between command start
 *    and the cache write is not clobbered by the stale in-memory tokens.
 */
describe('fetchAppInfo cache-write safety (FIX 2 / FIX 4)', () => {
  let tmpRoot: string;
  let fetchMock: jest.Mock<Promise<Response>, [string, RequestInit]>;
  const originalFetch = global.fetch;
  const ORIGINAL_XDG = process.env.XDG_CONFIG_HOME;

  function jsonResponse(status: number, body: unknown): Response {
    return {
      ok: status >= 200 && status < 300,
      status,
      text: async () => (body === undefined ? '' : JSON.stringify(body)),
    } as Response;
  }

  beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'crowi-cli-cap-'));
    process.env.XDG_CONFIG_HOME = tmpRoot;
    delete process.env.CROWI_PROFILE;
    delete process.env.CROWI_URL;
    delete process.env.CROWI_TOKEN;
    fetchMock = jest.fn();
    global.fetch = fetchMock as unknown as typeof fetch;
  });

  afterEach(() => {
    rmSync(tmpRoot, { recursive: true, force: true });
    if (ORIGINAL_XDG === undefined) {
      delete process.env.XDG_CONFIG_HOME;
    } else {
      process.env.XDG_CONFIG_HOME = ORIGINAL_XDG;
    }
    global.fetch = originalFetch;
  });

  it('does NOT persist an ad-hoc profile (one-shot PAT never reaches disk)', async () => {
    const adhoc: Profile = {
      alias: ADHOC_ALIAS,
      endpoint: 'https://wiki.example.com',
      tokens: { accessToken: 'one-shot-pat' },
    };
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { title: 'Wiki', apiVersion: 'v2', capabilities: ['pages', 'search'] }));

    const info = await fetchAppInfo(adhoc);
    // In-memory return value is unaffected.
    expect(info.capabilities).toEqual(['pages', 'search']);
    // Nothing written: the ad-hoc alias must not appear on disk.
    expect(loadConfig().profiles[ADHOC_ALIAS]).toBeUndefined();
  });

  it('does not clobber a token rotated between command start and the capability write', async () => {
    // The command captured this (now-stale) in-memory profile at start.
    const started: Profile = {
      alias: 'work',
      endpoint: 'https://wiki.example.com',
      tokens: { accessToken: 'OLD-access', refreshToken: 'OLD-refresh' },
    };
    // Meanwhile the refresh hook rotated + persisted fresh tokens on disk.
    upsertProfile({
      alias: 'work',
      endpoint: 'https://wiki.example.com',
      tokens: { accessToken: 'NEW-access', refreshToken: 'NEW-refresh' },
    });

    fetchMock.mockResolvedValueOnce(jsonResponse(200, { title: 'Wiki', apiVersion: 'v2', capabilities: ['pages', 'search'] }));
    await fetchAppInfo(started);

    const stored = loadConfig().profiles.work;
    // The capability fields landed…
    expect(stored.capabilities).toEqual(['pages', 'search']);
    expect(stored.apiVersion).toBe('v2');
    // …but the freshly-rotated tokens survived (NOT overwritten by OLD-*).
    expect(stored.tokens?.accessToken).toBe('NEW-access');
    expect(stored.tokens?.refreshToken).toBe('NEW-refresh');
  });

  it('no-ops when the stored named profile no longer exists', async () => {
    const ghost: Profile = {
      alias: 'ghost',
      endpoint: 'https://wiki.example.com',
      tokens: { accessToken: 'pat-1' },
    };
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { title: 'Wiki', apiVersion: 'v2' }));
    await fetchAppInfo(ghost);
    expect(loadConfig().profiles.ghost).toBeUndefined();
  });
});
