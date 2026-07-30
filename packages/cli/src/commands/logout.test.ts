import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Command } from 'commander';

import { loadConfig, upsertProfile } from '../lib/config';
import { registerLogout } from './logout';

/**
 * feature-api-v2-path-removal Phase 2 — `revokeToken()` is now status-aware
 * (see `lib/oauth.ts`), so a server-side revoke failure (e.g. a profile
 * whose cached `revokeEndpoint` still targets a pre-`/api`-cutover path,
 * 404ing) must not be reported as a silent success: `crowi logout` warns the
 * user that the server-side token is still live. The local profile is still
 * removed either way — a network-unreachable server must not strand local
 * credentials. `fetch` is mocked — no network.
 */

function jsonResponse(status: number): Response {
  return { ok: status >= 200 && status < 300, status } as Response;
}

let fetchMock: jest.Mock<Promise<Response>, [string, RequestInit]>;
const originalFetch = global.fetch;
let tmpRoot: string;
const ORIGINAL_XDG = process.env.XDG_CONFIG_HOME;
let stderr: jest.SpyInstance;

function build(): Command {
  const program = new Command();
  program.exitOverride();
  program.option('-p, --profile <alias>').option('--url <baseUrl>').option('--token <accessToken>').option('--json').option('-q, --quiet');
  registerLogout(program);
  return program;
}

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'crowi-cli-logout-'));
  process.env.XDG_CONFIG_HOME = tmpRoot;
  delete process.env.CROWI_PROFILE;
  delete process.env.CROWI_URL;
  delete process.env.CROWI_TOKEN;
  fetchMock = jest.fn();
  global.fetch = fetchMock as unknown as typeof fetch;
  stderr = jest.spyOn(process.stderr, 'write').mockImplementation(() => true);
});

afterEach(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
  if (ORIGINAL_XDG === undefined) {
    delete process.env.XDG_CONFIG_HOME;
  } else {
    process.env.XDG_CONFIG_HOME = ORIGINAL_XDG;
  }
  global.fetch = originalFetch;
  stderr.mockRestore();
});

function stderrText(): string {
  return stderr.mock.calls.map((c) => String(c[0])).join('');
}

describe('crowi logout — revoke-failure warning', () => {
  it('does NOT warn when the server accepts the revoke (200)', async () => {
    upsertProfile({
      alias: 'work',
      endpoint: 'https://wiki.example.com',
      tokens: { accessToken: 'access-1', refreshToken: 'refresh-1' },
      oauth: { revokeEndpoint: 'https://wiki.example.com/api/oauth/revoke' },
    });
    fetchMock.mockResolvedValueOnce(jsonResponse(200));

    const program = build();
    await program.parseAsync(['logout', '--profile', 'work'], { from: 'user' });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(stderrText()).not.toContain('could not revoke');
    expect(loadConfig().profiles.work).toBeUndefined();
  });

  it('warns — but still removes the local profile — when revoke 404s (e.g. a stale pre-cutover endpoint)', async () => {
    upsertProfile({
      alias: 'work',
      endpoint: 'https://wiki.example.com',
      tokens: { accessToken: 'access-1', refreshToken: 'refresh-1' },
      oauth: { revokeEndpoint: 'https://wiki.example.com/api/v2/oauth/revoke' },
    });
    fetchMock.mockResolvedValueOnce(jsonResponse(404));

    const program = build();
    await program.parseAsync(['logout', '--profile', 'work'], { from: 'user' });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const text = stderrText();
    expect(text).toContain('could not revoke the server-side token');
    expect(text).toContain('crowi login');
    // Local credentials are removed regardless of the server-side outcome —
    // logout must never strand the user with local creds it claims to have
    // cleared.
    expect(loadConfig().profiles.work).toBeUndefined();
  });

  it('warns when the revoke request fails outright (network error)', async () => {
    upsertProfile({
      alias: 'work',
      endpoint: 'https://wiki.example.com',
      tokens: { accessToken: 'access-1', refreshToken: 'refresh-1' },
      oauth: { revokeEndpoint: 'https://wiki.example.com/api/oauth/revoke' },
    });
    fetchMock.mockRejectedValueOnce(new TypeError('fetch failed'));

    const program = build();
    await program.parseAsync(['logout', '--profile', 'work'], { from: 'user' });

    expect(stderrText()).toContain('could not revoke the server-side token');
    expect(loadConfig().profiles.work).toBeUndefined();
  });

  it('skips the revoke call (and any warning) when the profile has no refresh token', async () => {
    upsertProfile({
      alias: 'work',
      endpoint: 'https://wiki.example.com',
      tokens: { accessToken: 'access-1' },
    });

    const program = build();
    await program.parseAsync(['logout', '--profile', 'work'], { from: 'user' });

    expect(fetchMock).not.toHaveBeenCalled();
    expect(stderrText()).not.toContain('could not revoke');
    expect(loadConfig().profiles.work).toBeUndefined();
  });
});
