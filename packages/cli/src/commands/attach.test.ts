import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Command } from 'commander';

import { upsertProfile } from '../lib/config';
import { setRefreshHook } from '../lib/http';
import { registerAttach } from './attach';

/**
 * `attach add` used to build its multipart part with `new Blob([bytes])` and no
 * `type`, so every upload was declared `application/octet-stream` regardless of
 * what the file actually was. The server stores the declared type verbatim as
 * `fileFormat`, and attachment delivery only serves an allow-listed type inline
 * — so a PNG uploaded through the CLI came back as a download instead of an
 * image. These tests pin the declared type to the file's extension.
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
  tmpRoot = mkdtempSync(join(tmpdir(), 'crowi-cli-attach-'));
  process.env.XDG_CONFIG_HOME = tmpRoot;
  delete process.env.CROWI_PROFILE;
  delete process.env.CROWI_URL;
  delete process.env.CROWI_TOKEN;
  fetchMock = jest.fn();
  global.fetch = fetchMock as unknown as typeof fetch;
  stderr = jest.spyOn(process.stderr, 'write').mockImplementation(() => true);
  stdout = jest.spyOn(process.stdout, 'write').mockImplementation(() => true);
  setRefreshHook(undefined);
  upsertProfile({ alias: 'work', endpoint: 'https://wiki.example.com', tokens: { accessToken: 'pat-1', scope: 'attachments:write' } });
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
  registerAttach(program);
  return program;
}

/** Upload `name` and return the declared type of the multipart `file` part. */
async function declaredTypeFor(name: string): Promise<string> {
  const file = join(tmpRoot, name);
  writeFileSync(file, Buffer.from([0x00, 0x01, 0x02]));

  fetchMock.mockResolvedValueOnce(jsonResponse(200, { page: { _id: 'p1', path: '/a', revision: { _id: 'r1' } } }));
  fetchMock.mockResolvedValueOnce(jsonResponse(200, { url: '/api/attachments/a1' }));

  await build().parseAsync(['attach', 'add', '/a', file], { from: 'user' });

  const uploadInit = fetchMock.mock.calls[1][1];
  const form = uploadInit.body as FormData;
  const part = form.get('file');
  if (!(part instanceof Blob)) throw new Error('the `file` part is not a Blob');
  return part.type;
}

describe('attach add — declares the file’s media type on the multipart part', () => {
  it('declares image/png for a .png', async () => {
    expect(await declaredTypeFor('shot.png')).toBe('image/png');
  });

  it('declares image/jpeg for both .jpg and .jpeg', async () => {
    expect(await declaredTypeFor('a.jpg')).toBe('image/jpeg');
    fetchMock.mockClear();
    expect(await declaredTypeFor('b.jpeg')).toBe('image/jpeg');
  });

  it('is case-insensitive about the extension', async () => {
    expect(await declaredTypeFor('SHOT.PNG')).toBe('image/png');
  });

  it('declares application/pdf for a .pdf', async () => {
    expect(await declaredTypeFor('doc.pdf')).toBe('application/pdf');
  });

  it('falls back to application/octet-stream for an unknown extension', async () => {
    expect(await declaredTypeFor('thing.qqq')).toBe('application/octet-stream');
  });

  it('falls back to application/octet-stream when there is no extension', async () => {
    expect(await declaredTypeFor('README')).toBe('application/octet-stream');
  });

  it('still sends the filename alongside the declared type', async () => {
    const file = join(tmpRoot, 'named.png');
    writeFileSync(file, Buffer.from([0x00]));
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { page: { _id: 'p1', path: '/a', revision: { _id: 'r1' } } }));
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { url: '/api/attachments/a1' }));

    await build().parseAsync(['attach', 'add', '/a', file], { from: 'user' });

    const form = fetchMock.mock.calls[1][1].body as FormData;
    const part = form.get('file') as File;
    expect(part.name).toBe('named.png');
    expect(part.type).toBe('image/png');
  });
});
