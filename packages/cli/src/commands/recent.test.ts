import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { Command } from 'commander';

import { createProgram } from '../cli';
import { upsertProfile } from '../lib/config';
import { CliError, EXIT, setRefreshHook } from '../lib/http';

function jsonResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => (body === undefined ? '' : JSON.stringify(body)),
  } as Response;
}

type Handler = (url: URL) => Response | Promise<Response>;

let fetchMock: jest.Mock<Promise<Response>, [string, RequestInit?]>;
let handler: Handler;
const originalFetch = global.fetch;
const ORIGINAL_XDG = process.env.XDG_CONFIG_HOME;
let tmpRoot: string;
let stdout: jest.SpyInstance;
let stderr: jest.SpyInstance;

const urls = () => fetchMock.mock.calls.map((c) => new URL(c[0]));
const listCalls = () => urls().filter((u) => u.pathname.endsWith('/pages/list'));
const out = () => stdout.mock.calls.map((c) => String(c[0])).join('');
const err = () => stderr.mock.calls.map((c) => String(c[0])).join('');

const page = (over: Record<string, unknown> = {}) => ({
  _id: 'p1',
  path: '/a',
  updatedAt: '2026-01-02T03:04:05.000Z',
  lastUpdateUser: { _id: 'u1', username: 'alice', name: 'Alice' },
  ...over,
});
const listBody = (pages: unknown[], extra: Record<string, unknown> = {}) => ({
  pages,
  pager: { prev: null, next: null, offset: 0 },
  total: pages.length,
  ...extra,
});

function buildRecentProgram(): Command {
  const program = createProgram();
  const quiet = { writeOut: () => undefined, writeErr: () => undefined };
  program.exitOverride();
  program.configureOutput(quiet);
  for (const sub of program.commands) {
    sub.exitOverride();
    sub.configureOutput(quiet);
  }
  return program;
}

async function run(...args: string[]): Promise<void> {
  await buildRecentProgram().parseAsync(args, { from: 'user' });
}

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'crowi-cli-recent-'));
  process.env.XDG_CONFIG_HOME = tmpRoot;
  delete process.env.CROWI_PROFILE;
  delete process.env.CROWI_URL;
  delete process.env.CROWI_TOKEN;
  handler = (url) => (url.pathname.endsWith('/app/info') ? jsonResponse(200, { version: '1.0.0' }) : jsonResponse(200, listBody([])));
  fetchMock = jest.fn(async (url: string) => handler(new URL(url)));
  global.fetch = fetchMock as unknown as typeof fetch;
  stdout = jest.spyOn(process.stdout, 'write').mockImplementation(() => true);
  stderr = jest.spyOn(process.stderr, 'write').mockImplementation(() => true);
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
  stderr.mockRestore();
  setRefreshHook(undefined);
});

describe('recent', () => {
  it('recent defaults and explicit paging call only pages/list', async () => {
    await run('recent');
    expect(listCalls()).toHaveLength(1);
    const q = listCalls()[0].searchParams;
    expect(Object.fromEntries(q)).toEqual({ limit: '50', offset: '0', sort: 'updatedAt', order: 'desc' });
    expect(urls().some((u) => u.pathname.endsWith('/search'))).toBe(false);

    fetchMock.mockClear();
    handler = (url) => (url.pathname.endsWith('/app/info') ? jsonResponse(200, {}) : jsonResponse(200, listBody([], { appliedPathPrefix: '/team/' })));
    await run('recent', '--limit', '20', '--offset', '040', '--prefix', '/team/');
    expect(Object.fromEntries(listCalls()[0].searchParams)).toEqual({ limit: '20', offset: '40', sort: 'updatedAt', order: 'desc', path_prefix: '/team/' });
    expect(listCalls()[0].searchParams.has('include_deleted')).toBe(false);

    fetchMock.mockClear();
    await run('--url', 'https://adhoc.example.com', '--token', 'tok', 'recent');
    expect(listCalls()[0].origin).toBe('https://adhoc.example.com');
    expect((fetchMock.mock.calls.find((c) => c[0].includes('/pages/list'))?.[1]?.headers as Record<string, string>).Authorization).toBe('Bearer tok');
  });

  it('invalid recent args make zero requests', async () => {
    const bad = [
      ['--limit', ''],
      ['--limit', '0'],
      ['--limit', '-1'],
      ['--limit', '+5'],
      ['--limit', '1.5'],
      ['--limit', '1e2'],
      ['--limit', ' 5'],
      ['--limit', 'abc'],
      ['--limit', '101'],
      ['--limit', '99999999999999999999'],
      ['--offset', '-1'],
      ['--offset', '2147483648'],
      ['--offset', '0x10'],
      ['--offset', 'NaN'],
      ['--prefix', ''],
      ['--format', 'xml'],
      ['--format', 'json', '--template', '{{path}}'],
    ];
    for (const args of bad) {
      await expect(run('recent', ...args)).rejects.toMatchObject({ exitCode: EXIT.INVALID });
    }
    await expect(run('recent', 'extra')).rejects.toThrow();
    expect(fetchMock).not.toHaveBeenCalled();

    // Cold profile: still a validation error, not "not signed in".
    rmSync(tmpRoot, { recursive: true, force: true });
    tmpRoot = mkdtempSync(join(tmpdir(), 'crowi-cli-recent-'));
    process.env.XDG_CONFIG_HOME = tmpRoot;
    await expect(run('recent', '--limit', '0')).rejects.toMatchObject({ exitCode: EXIT.INVALID });
    expect(fetchMock).not.toHaveBeenCalled();

    // Boundaries are accepted.
    upsertProfile({ alias: 'work', endpoint: 'https://wiki.example.com', tokens: { accessToken: 'pat-1', scope: 'pages:read' } });
    await run('recent', '--limit', '1', '--offset', '0');
    await run('recent', '--limit', '100', '--offset', '2147483647');
    expect(listCalls()).toHaveLength(2);
  });

  it('valid recent probes version once after validation', async () => {
    handler = (url) => (url.pathname.endsWith('/app/info') ? jsonResponse(200, { version: '9.9.9', apiVersion: 'v99' }) : jsonResponse(200, listBody([])));
    await run('--profile', 'work', 'recent');
    expect(urls().filter((u) => u.pathname.endsWith('/app/info'))).toHaveLength(1);
    expect(urls()[0].pathname.endsWith('/app/info')).toBe(true);
    expect(err()).toContain('continuing anyway');
    expect(out()).not.toContain('continuing anyway');
  });

  it('normalizes only a missing leading slash and root alias', async () => {
    const sent = async (prefix: string) => {
      fetchMock.mockClear();
      handler = (url) =>
        url.pathname.endsWith('/app/info')
          ? jsonResponse(200, {})
          : jsonResponse(200, listBody([], { appliedPathPrefix: prefix.startsWith('/') ? prefix : `/${prefix}` }));
      await run('recent', '--prefix', prefix);
      return listCalls()[0].searchParams.get('path_prefix');
    };
    expect(await sent('team')).toBe('/team');
    expect(await sent('/team/')).toBe('/team/');
    expect(await sent(' /x ')).toBe('/ /x ');
    expect(await sent('日本語/Ü')).toBe('/日本語/Ü');
    expect(await sent('a//b/../c')).toBe('/a//b/../c');
    expect(await sent('a&b=c')).toBe('/a&b=c');
    expect(listCalls()[0].search).toContain('path_prefix=%2Fa%26b%3Dc');

    for (const root of ['/', '']) {
      fetchMock.mockClear();
      handler = (url) => (url.pathname.endsWith('/app/info') ? jsonResponse(200, {}) : jsonResponse(200, listBody([])));
      if (root === '') {
        await expect(run('recent', '--prefix', root)).rejects.toMatchObject({ exitCode: EXIT.INVALID });
      } else {
        await run('recent', '--prefix', root);
        expect(listCalls()[0].searchParams.has('path_prefix')).toBe(false);
      }
    }
  });

  it('unconfirmed prefix never reaches stdout', async () => {
    const responses: unknown[] = [
      listBody([page({ path: '/team/a' })]),
      listBody([page({ path: '/team/a' })], { appliedPathPrefix: '/other' }),
      listBody([page({ path: '/team/a' })], { appliedPathPrefix: null }),
      listBody([], { appliedPathPrefix: 5 }),
      listBody([]),
    ];
    const variants: string[][] = [[], ['--format', 'table'], ['--template', '{{path}}'], ['--json'], ['--quiet']];
    for (const body of responses) {
      for (const variant of variants) {
        handler = (url) => (url.pathname.endsWith('/app/info') ? jsonResponse(200, {}) : jsonResponse(200, body));
        await expect(run('recent', '--prefix', '/team/', ...variant)).rejects.toMatchObject({
          exitCode: EXIT.UNAVAILABLE,
          message: 'server did not confirm literal prefix filtering; upgrade Crowi and retry',
        });
      }
    }
    expect(out()).toBe('');
  });

  it('old root response and prefix root alias work without metadata', async () => {
    handler = (url) => (url.pathname.endsWith('/app/info') ? jsonResponse(200, {}) : jsonResponse(200, listBody([page()])));
    await run('recent');
    await run('recent', '--prefix', '/');
    expect(out().split('\n').filter(Boolean)).toHaveLength(2);

    const statuses: Array<[number, number]> = [
      [400, EXIT.INVALID],
      [401, EXIT.UNAUTHENTICATED],
      [403, EXIT.FORBIDDEN],
      [500, EXIT.GENERAL],
    ];
    for (const [status, exitCode] of statuses) {
      handler = (url) => (url.pathname.endsWith('/app/info') ? jsonResponse(200, {}) : jsonResponse(status, { error: { code: 'X', message: 'm' } }));
      await expect(run('recent')).rejects.toMatchObject({ exitCode });
    }
    handler = (url) => {
      if (url.pathname.endsWith('/app/info')) return jsonResponse(200, {});
      throw new TypeError('fetch failed');
    };
    await expect(run('recent')).rejects.toBeDefined();
  });

  it('renders four columns from updater not creator', async () => {
    const pages = [
      page({ _id: 'p1', path: '/a', creator: { username: 'creator' } }),
      page({ _id: 'p2', path: '/b', lastUpdateUser: { _id: 'u9', name: 'Bob' } }),
      page({ _id: 'p3', path: '/c', lastUpdateUser: { _id: 'u10' } }),
      page({ _id: 'p4', path: '/d', lastUpdateUser: 'u11', updatedAt: 'not a date' }),
      page({ _id: 'p5', path: '/e', lastUpdateUser: null, updatedAt: null, creator: { username: 'creator' } }),
      page({ _id: 'p6', path: '/f\n\tg', lastUpdateUser: { username: 'x\ny' }, updatedAt: '2026-01-02T12:04:05+09:00' }),
      { path: '/only-path' },
    ];
    handler = (url) => (url.pathname.endsWith('/app/info') ? jsonResponse(200, {}) : jsonResponse(200, listBody(pages)));
    await run('recent');
    expect(out().split('\n').filter(Boolean)).toEqual([
      '/a\t2026-01-02T03:04:05.000Z\talice\tp1',
      '/b\t2026-01-02T03:04:05.000Z\tBob\tp2',
      '/c\t2026-01-02T03:04:05.000Z\tu10\tp3',
      '/d\t\tu11\tp4',
      '/e\t\t\tp5',
      '/f g\t2026-01-02T03:04:05.000Z\tx y\tp6',
      '/only-path\t\t\t',
    ]);

    stdout.mockClear();
    await run('recent', '--format', 'table');
    const lines = out().split('\n').filter(Boolean);
    expect(lines).toHaveLength(8);
    expect(lines[0].split(/\s+/)).toEqual(['path', 'updatedAt', 'lastUpdateUser', '_id']);
    expect(lines[1]).toContain('alice');

    stdout.mockClear();
    await run('recent', '--template', '{{path}}|{{lastUpdateUser.username}}|{{lastUpdateUser._id}}');
    expect(out().split('\n')[0]).toBe('/a|alice|u1');
    expect(out().split('\n')[2]).toBe('/c||u10');

    stdout.mockClear();
    await run('recent', '--format', 'template');
    const first = out().split('\n')[0].split('\t');
    expect(first[2]).toBe(JSON.stringify((pages[0] as { lastUpdateUser: unknown }).lastUpdateUser));
  });

  it('preserves raw JSON and empty conventions', async () => {
    const body = { ...listBody([page({ extra: { deep: [1, 2] } })], { appliedPathPrefix: '/a' }), total: 77, unknownTop: { k: 'v' } };
    handler = (url) => (url.pathname.endsWith('/app/info') ? jsonResponse(200, {}) : jsonResponse(200, body));
    await run('recent', '--prefix', '/a', '--json');
    expect(JSON.parse(out())).toEqual(body);

    stdout.mockClear();
    await run('recent', '--prefix', '/a', '--format', 'json');
    expect(JSON.parse(out())).toEqual(body);

    // Empty sets.
    handler = (url) => (url.pathname.endsWith('/app/info') ? jsonResponse(200, {}) : jsonResponse(200, listBody([])));
    stdout.mockClear();
    await run('recent');
    expect(out()).toBe('(no recently updated pages)\n');
    stdout.mockClear();
    await run('recent', '--format', 'table');
    await run('recent', '--template', '{{path}}');
    expect(out()).toBe('');
    stdout.mockClear();
    await run('recent', '--json');
    expect(JSON.parse(out()).pages).toEqual([]);

    // pages missing → empty; pages malformed → general error.
    handler = (url) => (url.pathname.endsWith('/app/info') ? jsonResponse(200, {}) : jsonResponse(200, { total: 0 }));
    stdout.mockClear();
    await run('recent');
    expect(out()).toBe('(no recently updated pages)\n');
    for (const broken of [{ pages: 'x' }, { pages: {} }, { pages: [1] }, { pages: [null] }]) {
      handler = (url) => (url.pathname.endsWith('/app/info') ? jsonResponse(200, {}) : jsonResponse(200, broken));
      await expect(run('recent')).rejects.toMatchObject({ exitCode: EXIT.GENERAL });
      await expect(run('recent', '--json')).rejects.toBeInstanceOf(CliError);
    }

    // Format precedence: --template wins over the global --json.
    handler = (url) => (url.pathname.endsWith('/app/info') ? jsonResponse(200, {}) : jsonResponse(200, listBody([page()])));
    stdout.mockClear();
    await run('--json', 'recent', '--template', '{{path}}');
    expect(out()).toBe('/a\n');
  });
});

describe('ls and search keep their requests and outputs', () => {
  it('ls and search preserve requests and raw outputs', async () => {
    handler = (url) => {
      if (url.pathname.endsWith('/app/info')) return jsonResponse(200, {});
      if (url.pathname.endsWith('/pages/children'))
        return jsonResponse(200, {
          children: [
            { path: '/a/', hasPortal: true, count: 2 },
            { path: '/b', isPage: true },
          ],
        });
      return jsonResponse(200, { meta: { total: 1 }, data: [{ path: '/s', snippet: '<mark>hi</mark> there' }] });
    };
    await run('ls', '/a');
    expect(
      urls()
        .find((u) => u.pathname.endsWith('/pages/children'))
        ?.searchParams.get('path'),
    ).toBe('/a');
    expect(out()).toBe('/a/\n/b\n');

    stdout.mockClear();
    await run('search', 'hello', '--limit', '5');
    const searchUrl = urls().find((u) => u.pathname.endsWith('/search'));
    expect(searchUrl?.searchParams.get('q')).toBe('hello');
    expect(searchUrl?.searchParams.get('limit')).toBe('5');
    expect(out()).toBe('/s — hi there\n');

    stdout.mockClear();
    await run('search', 'hello', '--json');
    expect(JSON.parse(out()).data[0].path).toBe('/s');
  });
});
