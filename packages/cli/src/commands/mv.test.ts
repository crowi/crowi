import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { IDEMPOTENCY_KEY_PATTERN } from '@crowi/api-contract';
import { Command } from 'commander';

import { upsertProfile } from '../lib/config';
import { setRefreshHook } from '../lib/http';
import { registerMv } from './mv';

/**
 * These tests pin the Idempotency-Key header on both rename routes `crowi
 * mv` can take (single-page and subtree) — a server enforcing RFC-0021
 * Phase 2c-2a rejects a rename request that lacks the header with a 400.
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

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'crowi-cli-mv-'));
  process.env.XDG_CONFIG_HOME = tmpRoot;
  delete process.env.CROWI_PROFILE;
  delete process.env.CROWI_URL;
  delete process.env.CROWI_TOKEN;
  fetchMock = jest.fn();
  global.fetch = fetchMock as unknown as typeof fetch;
  stderr = jest.spyOn(process.stderr, 'write').mockImplementation(() => true);
  stdout = jest.spyOn(process.stdout, 'write').mockImplementation(() => true);
  setRefreshHook(undefined);
  upsertProfile({ alias: 'work', endpoint: 'https://wiki.example.com', tokens: { accessToken: 'pat-1', scope: 'pages:write' } });
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

function build(): Command {
  const program = new Command();
  program.exitOverride();
  program.option('-p, --profile <alias>').option('--url <baseUrl>').option('--token <accessToken>').option('--json').option('-q, --quiet');
  registerMv(program);
  return program;
}

/** The `(url, init)` call whose `init.method` matches, for header inspection. */
function callFor(mock: jest.Mock<Promise<Response>, [string, RequestInit]>, method: string): RequestInit {
  const call = mock.mock.calls.find(([, init]) => init.method === method);
  if (!call) throw new Error(`no ${method} call was made`);
  return call[1];
}

describe('crowi mv — idempotency key', () => {
  it('sends an idempotency key on the single-page rename', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { page: { _id: 'p1', path: '/old', revision: { _id: 'r1' } } }));
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { page: { _id: 'p1', path: '/new' }, renamed_count: 1 }));

    await build().parseAsync(['mv', '/old', '/new'], { from: 'user' });

    const init = callFor(fetchMock, 'POST');
    const headers = init.headers as Record<string, string>;
    expect(headers['idempotency-key']).toMatch(IDEMPOTENCY_KEY_PATTERN);
  });

  it('sends an idempotency key on the subtree rename', async () => {
    // No page document at the old path (404) → falls back to the path-keyed
    // subtree rename.
    fetchMock.mockResolvedValueOnce(jsonResponse(404, { error: { code: 'PAGE_NOT_FOUND', message: 'nope' } }));
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { renamed_count: 3 }));

    await build().parseAsync(['mv', '/old-folder', '/new-folder'], { from: 'user' });

    const init = callFor(fetchMock, 'POST');
    expect((init.body as string).length).toBeGreaterThan(0);
    const headers = init.headers as Record<string, string>;
    expect(headers['idempotency-key']).toMatch(IDEMPOTENCY_KEY_PATTERN);
  });
});
