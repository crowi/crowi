import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { effectiveCapabilities, hasCapability, maybeWarnVersionSkew, STATIC_CAPABILITIES, warnVersionSkew } from './capability';

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
});
