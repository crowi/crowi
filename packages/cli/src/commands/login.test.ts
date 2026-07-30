import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Command } from 'commander';

import { loadConfig, type Profile } from '../lib/config';
import { setRefreshHook } from '../lib/http';
import { fetchAccount, registerLogin } from './login';

/**
 * After a successful login the CLI does a best-effort one-shot
 * `GET /api/auth/me` to resolve `profile.account`, so `crowi profiles` can
 * show endpoint × user (spec §d). It must NEVER fail login: a flaky /auth/me
 * just leaves the account unset. `fetch` is mocked — no network.
 */

const PROFILE: Profile = {
  alias: 'work',
  endpoint: 'https://wiki.example.com',
  tokens: { accessToken: 'access-1' },
};

function jsonResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => (body === undefined ? '' : JSON.stringify(body)),
  } as Response;
}

let fetchMock: jest.Mock<Promise<Response>, [string, RequestInit]>;
const originalFetch = global.fetch;

beforeEach(() => {
  fetchMock = jest.fn();
  global.fetch = fetchMock as unknown as typeof fetch;
  setRefreshHook(undefined);
});

afterEach(() => {
  global.fetch = originalFetch;
  setRefreshHook(undefined);
});

describe('fetchAccount (best-effort /auth/me)', () => {
  it('returns the username from a successful /auth/me', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { user: { id: '1', username: 'alice' } }));
    await expect(fetchAccount(PROFILE)).resolves.toBe('alice');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toBe('https://wiki.example.com/api/auth/me');
  });

  it('returns undefined (never throws) when /auth/me fails with an error status', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(403, { error: { code: 'FORBIDDEN', message: 'nope' } }));
    await expect(fetchAccount(PROFILE)).resolves.toBeUndefined();
  });

  it('returns undefined (never throws) on a network failure', async () => {
    fetchMock.mockRejectedValueOnce(new Error('ECONNREFUSED'));
    await expect(fetchAccount(PROFILE)).resolves.toBeUndefined();
  });

  it('returns undefined when the response omits user.username', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { user: { id: '1' } }));
    await expect(fetchAccount(PROFILE)).resolves.toBeUndefined();
  });
});

/**
 * FIX 6: the `--token` PAT path must validate the token against `/auth/me`
 * BEFORE persisting. An invalid PAT (401/403) aborts login WITHOUT writing
 * config; a valid one stores the profile with `account` populated from the
 * same round-trip. (OAuth flows keep their best-effort fetchAccount — fresh
 * tokens — so only the PAT path is validating.)
 */
describe('crowi login --token <pat> (FIX 6 validation)', () => {
  let tmpRoot: string;
  const ORIGINAL_XDG = process.env.XDG_CONFIG_HOME;
  let stderr: jest.SpyInstance;

  function buildProgram(): Command {
    const program = new Command();
    program.exitOverride(); // throw instead of process.exit on parse errors
    // Mirror the real root globals, but NOT `--token`: login defines its own
    // `--token <pat>` subcommand option, and a duplicate global would shadow it.
    program.option('-p, --profile <alias>').option('--url <baseUrl>').option('--json').option('-q, --quiet');
    registerLogin(program);
    return program;
  }

  beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'crowi-cli-login-'));
    process.env.XDG_CONFIG_HOME = tmpRoot;
    delete process.env.CROWI_PROFILE;
    delete process.env.CROWI_URL;
    delete process.env.CROWI_TOKEN;
    stderr = jest.spyOn(process.stderr, 'write').mockImplementation(() => true);
  });

  afterEach(() => {
    rmSync(tmpRoot, { recursive: true, force: true });
    if (ORIGINAL_XDG === undefined) {
      delete process.env.XDG_CONFIG_HOME;
    } else {
      process.env.XDG_CONFIG_HOME = ORIGINAL_XDG;
    }
    stderr.mockRestore();
  });

  it('aborts WITHOUT writing config when /auth/me rejects the token (401)', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(401, { error: { code: 'UNAUTHENTICATED', message: 'bad token' } }));
    const program = buildProgram();
    await expect(program.parseAsync(['login', 'https://wiki.example.com', '--token', 'bogus-pat'], { from: 'user' })).rejects.toThrow(
      /personal access token was rejected/,
    );
    // No profile persisted.
    expect(loadConfig().profiles).toEqual({});
  });

  it('aborts WITHOUT writing config when the token cannot be verified (network failure)', async () => {
    fetchMock.mockRejectedValueOnce(new Error('ECONNREFUSED'));
    const program = buildProgram();
    await expect(program.parseAsync(['login', 'https://wiki.example.com', '--token', 'pat-1'], { from: 'user' })).rejects.toThrow(/could not verify the token/);
    expect(loadConfig().profiles).toEqual({});
  });

  it('stores the profile with account populated when /auth/me accepts the token', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { user: { id: '1', username: 'alice' } }));
    const program = buildProgram();
    await program.parseAsync(['login', 'https://wiki.example.com', '--token', 'good-pat'], { from: 'user' });

    const stored = loadConfig().profiles['wiki.example.com'];
    expect(stored).toBeDefined();
    expect(stored.tokens?.accessToken).toBe('good-pat');
    expect(stored.account).toBe('alice');
  });
});
