import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Command, CommanderError } from 'commander';

import { upsertProfile } from '../lib/config';
import { CliError, EXIT, setRefreshHook } from '../lib/http';
import { registerDiff, trimTrailingNewlines } from './diff';
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
  tmpRoot = mkdtempSync(join(tmpdir(), 'crowi-cli-diff-'));
  process.env.XDG_CONFIG_HOME = tmpRoot;
  delete process.env.CROWI_PROFILE;
  delete process.env.CROWI_URL;
  delete process.env.CROWI_TOKEN;
  fetchMock = jest.fn();
  global.fetch = fetchMock as unknown as typeof fetch;
  stdout = jest.spyOn(process.stdout, 'write').mockImplementation(() => true);
  jest.spyOn(process.stderr, 'write').mockImplementation(() => true);
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
  jest.restoreAllMocks();
  setRefreshHook(undefined);
});

function pageResponse(body: string): Response {
  return jsonResponse(200, { page: { _id: 'p1', path: '/a', revision: { _id: 'r1', body } } });
}

function out(): string {
  return stdout.mock.calls.map(([chunk]) => String(chunk)).join('');
}

function file(content: string): string {
  const path = join(tmpRoot, 'f.md');
  writeFileSync(path, content);
  return path;
}

async function run(args: string[]): Promise<unknown> {
  const program = new Command();
  program.exitOverride();
  program.option('-p, --profile <alias>').option('--url <baseUrl>').option('--token <accessToken>').option('--json').option('-q, --quiet');
  registerDiff(program);
  registerGet(program);
  return program.parseAsync(args, { from: 'user' }).then(
    () => undefined,
    (err: unknown) => err,
  );
}

describe('trimTrailingNewlines', () => {
  it('strips only trailing LF / CRLF runs', () => {
    expect(trimTrailingNewlines('a\r\n\n\r\n')).toBe('a');
    expect(trimTrailingNewlines('a \n')).toBe('a ');
    expect(trimTrailingNewlines('a\r\nb\n')).toBe('a\r\nb');
  });
});

describe('crowi diff', () => {
  it.each(['a', 'a\n', 'a\n\n', 'a\r\n'])('exits 0 silently when only trailing newlines differ (%j)', async (content) => {
    fetchMock.mockResolvedValueOnce(pageResponse('a\n'));
    expect(await run(['diff', '/a', '--file', file(content)])).toBeUndefined();
    expect(out()).toBe('');
  });

  it('prints a unified diff and fails with exit 1 on a content difference', async () => {
    fetchMock.mockResolvedValueOnce(pageResponse('a\nb\n'));
    const f = file('a\nc\n');
    const err = (await run(['diff', '/a', '--file', f])) as CliError;
    expect(err).toBeInstanceOf(CliError);
    expect(err.message).toBe('page and file differ');
    expect(err.exitCode).toBe(1);
    const text = out();
    expect(text.startsWith(`--- /a (wiki)\n+++ ${f}\n`)).toBe(true);
    expect(text).toContain('-b\n+c\n');
    expect(text.endsWith('\n\n')).toBe(false);
  });

  it('treats trailing spaces and mid-text CRLF as differences', async () => {
    fetchMock.mockResolvedValueOnce(pageResponse('a\nb\n'));
    expect(((await run(['diff', '/a', '--file', file('a \nb\n')])) as CliError).exitCode).toBe(1);
    fetchMock.mockResolvedValueOnce(pageResponse('a\nb\n'));
    expect(((await run(['diff', '/a', '--file', file('a\r\nb\n')])) as CliError).exitCode).toBe(1);
  });

  it('--json reports identical and different', async () => {
    fetchMock.mockResolvedValueOnce(pageResponse('a\n'));
    expect(await run(['--json', 'diff', '/a', '--file', file('a')])).toBeUndefined();
    expect(JSON.parse(out())).toMatchObject({ identical: true, diff: null, path: '/a', pageId: 'p1', revisionId: 'r1' });
    stdout.mockClear();

    fetchMock.mockResolvedValueOnce(pageResponse('a\n'));
    const err = (await run(['--json', 'diff', '/a', '--file', file('b')])) as CliError;
    expect(err.exitCode).toBe(1);
    const json = JSON.parse(out());
    expect(json.identical).toBe(false);
    expect(json.diff).toContain('-a\n+b');
  });

  it('exits 4 on a missing page without printing a diff', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(404, { error: { code: 'PAGE_NOT_FOUND', message: 'nope' } }));
    const err = (await run(['diff', '/a', '--file', file('a')])) as CliError;
    expect(err.exitCode).toBe(EXIT.NOT_FOUND);
    expect(out()).toBe('');
  });

  it('exits 6 on an unreadable file without calling the server', async () => {
    const err = (await run(['diff', '/a', '--file', join(tmpRoot, 'missing.md')])) as CliError;
    expect(err.exitCode).toBe(EXIT.INVALID);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(out()).toBe('');
  });

  it('requires --file', async () => {
    const err = (await run(['diff', '/a'])) as CommanderError;
    expect(err).toBeInstanceOf(CommanderError);
    expect(err.code).toBe('commander.missingMandatoryOptionValue');
  });

  it('a file saved from `get` compares equal', async () => {
    const body = 'hello\nworld\n';
    fetchMock.mockResolvedValueOnce(pageResponse(body));
    await run(['get', '/a']);
    const saved = out();
    stdout.mockClear();
    fetchMock.mockResolvedValueOnce(pageResponse(body));
    expect(await run(['diff', '/a', '--file', file(saved)])).toBeUndefined();
    expect(out()).toBe('');
  });
});
