import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Command } from 'commander';

import { upsertProfile } from '../lib/config';
import { setRefreshHook } from '../lib/http';
import { registerGet } from './get';

function jsonResponse(status: number, body: unknown): Response {
  return { ok: status >= 200 && status < 300, status, text: async () => JSON.stringify(body) } as Response;
}

let tmpRoot: string;
const ORIGINAL_XDG = process.env.XDG_CONFIG_HOME;
const originalFetch = global.fetch;
let stdout: jest.SpyInstance;
let fetchMock: jest.Mock;

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'crowi-cli-get-'));
  process.env.XDG_CONFIG_HOME = tmpRoot;
  delete process.env.CROWI_PROFILE;
  delete process.env.CROWI_URL;
  delete process.env.CROWI_TOKEN;
  fetchMock = jest.fn();
  global.fetch = fetchMock as unknown as typeof fetch;
  stdout = jest.spyOn(process.stdout, 'write').mockImplementation(() => true);
  setRefreshHook(undefined);
  upsertProfile({ alias: 'work', endpoint: 'https://wiki.example.com', tokens: { accessToken: 'pat-1', scope: 'pages:read' } });
});

afterEach(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
  if (ORIGINAL_XDG === undefined) {
    delete process.env.XDG_CONFIG_HOME;
  } else {
    process.env.XDG_CONFIG_HOME = ORIGINAL_XDG;
  }
  global.fetch = originalFetch;
  stdout.mockRestore();
  setRefreshHook(undefined);
});

async function run(body: string, extra: string[] = []): Promise<string> {
  fetchMock.mockResolvedValueOnce(jsonResponse(200, { page: { _id: 'p1', path: '/a', revision: { _id: 'r1', body } } }));
  const program = new Command();
  program.exitOverride();
  program.option('-p, --profile <alias>').option('--url <baseUrl>').option('--token <accessToken>').option('--json').option('-q, --quiet');
  registerGet(program);
  await program.parseAsync([...extra, 'get', '/a'], { from: 'user' });
  const out = stdout.mock.calls.map(([chunk]) => String(chunk)).join('');
  stdout.mockClear();
  return out;
}

describe('crowi get — human output', () => {
  it.each([
    ['a\n', 'a\n'],
    ['a', 'a\n'],
    ['a\n\n', 'a\n\n'],
    ['', '\n'],
  ])('prints body %j as %j', async (body, expected) => {
    expect(await run(body)).toBe(expected);
  });

  it('keeps --json body as the stored body', async () => {
    const out = JSON.parse(await run('a\n', ['--json']));
    expect(out.body).toBe('a\n');
  });
});
