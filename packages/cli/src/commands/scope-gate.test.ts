import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Command } from 'commander';

import { upsertProfile } from '../lib/config';
import { setRefreshHook } from '../lib/http';
import { registerAttach } from './attach';
import { registerBookmark } from './bookmark';
import { registerComment } from './comment';

/**
 * FIX 10: comment / attach / bookmark previously ran an `ensureCapability`
 * pre-flight (an `app/info` round-trip + a disk write) for capabilities that
 * are structurally always-on (`comments` / `attachments` / `bookmarks` are in
 * the static baseline, so the gate could never return false). The pre-flight
 * is removed: the real gate is the OAuth scope, surfaced by mapping a
 * 403 / INSUFFICIENT_SCOPE on the actual API call to the re-login hint.
 *
 * These tests assert (a) NO `/app/info` request is made (no fetchAppInfo) and
 * (b) a 403 / INSUFFICIENT_SCOPE still maps to the actionable re-login hint.
 */

function jsonResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => (body === undefined ? '' : JSON.stringify(body)),
  } as Response;
}

let fetchMock: jest.Mock<Promise<Response>, [string, RequestInit]>;
const originalFetch = global.fetch;
let tmpRoot: string;
const ORIGINAL_XDG = process.env.XDG_CONFIG_HOME;
let stderr: jest.SpyInstance;
let stdout: jest.SpyInstance;

/** URLs requested across all fetch calls (for the "no /app/info" assertion). */
function requestedUrls(): string[] {
  return fetchMock.mock.calls.map((c) => c[0]);
}

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'crowi-cli-scope-'));
  process.env.XDG_CONFIG_HOME = tmpRoot;
  delete process.env.CROWI_PROFILE;
  delete process.env.CROWI_URL;
  delete process.env.CROWI_TOKEN;
  fetchMock = jest.fn();
  global.fetch = fetchMock as unknown as typeof fetch;
  stderr = jest.spyOn(process.stderr, 'write').mockImplementation(() => true);
  stdout = jest.spyOn(process.stdout, 'write').mockImplementation(() => true);
  setRefreshHook(undefined);
  upsertProfile({ alias: 'work', endpoint: 'https://wiki.example.com', tokens: { accessToken: 'pat-1', scope: 'pages:read pages:write' } });
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
  stdout.mockRestore();
  setRefreshHook(undefined);
});

function build(register: (p: Command) => void): Command {
  const program = new Command();
  program.exitOverride();
  program.option('-p, --profile <alias>').option('--url <baseUrl>').option('--token <accessToken>').option('--json').option('-q, --quiet');
  register(program);
  return program;
}

describe('bookmark add — no capability pre-flight, scope-mapped 403', () => {
  it('does not request /app/info and maps INSUFFICIENT_SCOPE to the re-login hint', async () => {
    // 1) /pages resolves the page id; 2) /bookmarks 403s with INSUFFICIENT_SCOPE.
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { page: { _id: 'p1', path: '/a', revision: { _id: 'r1' } } }));
    fetchMock.mockResolvedValueOnce(jsonResponse(403, { error: { code: 'INSUFFICIENT_SCOPE', message: 'need bookmarks:write' } }));

    const program = build(registerBookmark);
    await expect(program.parseAsync(['bookmark', 'add', '/a'], { from: 'user' })).rejects.toThrow(/re-login granting it/);

    // No app/info round-trip anywhere.
    expect(requestedUrls().some((u) => u.includes('/app/info'))).toBe(false);
    expect(requestedUrls()).toEqual(['https://wiki.example.com/api/v2/pages?path=%2Fa', 'https://wiki.example.com/api/v2/bookmarks']);
  });
});

describe('comment list — no capability pre-flight, scope-mapped 403', () => {
  it('does not request /app/info and maps a 403 to the re-login hint', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { page: { _id: 'p1', path: '/a', revision: { _id: 'r1' } } }));
    fetchMock.mockResolvedValueOnce(jsonResponse(403, { error: { code: 'FORBIDDEN', message: 'nope' } }));

    const program = build(registerComment);
    await expect(program.parseAsync(['comment', 'list', '/a'], { from: 'user' })).rejects.toThrow(/re-login granting it/);
    expect(requestedUrls().some((u) => u.includes('/app/info'))).toBe(false);
  });
});

describe('attach list — no capability pre-flight, scope-mapped 403', () => {
  it('does not request /app/info and maps a 403 to the re-login hint', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { page: { _id: 'p1', path: '/a', revision: { _id: 'r1' } } }));
    fetchMock.mockResolvedValueOnce(jsonResponse(403, { error: { code: 'INSUFFICIENT_SCOPE', message: 'need attachments:read' } }));

    const program = build(registerAttach);
    await expect(program.parseAsync(['attach', 'list', '/a'], { from: 'user' })).rejects.toThrow(/re-login granting it/);
    expect(requestedUrls().some((u) => u.includes('/app/info'))).toBe(false);
  });
});
