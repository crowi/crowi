import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Command } from 'commander';

import { upsertProfile } from '../lib/config';
import { type CliError, setRefreshHook } from '../lib/http';
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

const ATTACHMENT_ID = '0123456789abcdef01234567';

/**
 * A byte-carrying `Response` shaped like the strict download route's: a web
 * `ReadableStream` body plus real `Headers` (the command reads
 * `content-type` / `content-disposition` / `content-length` off them).
 */
function binaryResponse(
  bytes: Buffer,
  overrides: { status?: number; contentType?: string | null; disposition?: string | null; contentLength?: string } = {},
): Response {
  const status = overrides.status ?? 200;
  const headers = new Headers();
  const contentType = overrides.contentType === undefined ? 'application/octet-stream' : overrides.contentType;
  const disposition = overrides.disposition === undefined ? "attachment; filename*=UTF-8''note.txt" : overrides.disposition;
  if (contentType !== null) headers.set('content-type', contentType);
  if (disposition !== null) headers.set('content-disposition', disposition);
  if (overrides.contentLength !== undefined) headers.set('content-length', overrides.contentLength);

  return {
    ok: status >= 200 && status < 300,
    status,
    type: 'default',
    headers,
    body: new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(bytes));
        controller.close();
      },
    }),
    text: async () => bytes.toString('utf8'),
  } as unknown as Response;
}

/**
 * Run `attach download` and return the rejection, asserting there was one.
 * Globals (`--json`) go before the subcommand — commander resolves them via
 * `optsWithGlobals`, and they are only declared on the program.
 */
async function downloadFailure(args: string[], globals: string[] = []): Promise<CliError> {
  const error = await build()
    .parseAsync([...globals, 'attach', 'download', ...args], { from: 'user' })
    .then(
      () => undefined,
      (err: unknown) => err as CliError,
    );
  if (!error) throw new Error('expected the download to fail');
  return error;
}

/**
 * `attach download` writes bytes, so every guard here is about refusing to
 * write the WRONG bytes. The strict route it calls never substitutes the
 * `file-not-found.png` placeholder the browser-facing delivery routes serve,
 * and these tests pin the client half of that contract: a response that is
 * not the route's own answer must not reach the caller's disk.
 */
describe('attach download', () => {
  it('writes the attachment to the -o path and reports it on stderr', async () => {
    const bytes = Buffer.from('hello attachment', 'utf8');
    fetchMock.mockResolvedValueOnce(binaryResponse(bytes, { contentLength: String(bytes.length) }));
    const out = join(tmpRoot, 'note.txt');

    await build().parseAsync(['attach', 'download', ATTACHMENT_ID, '-o', out], { from: 'user' });

    expect(readFileSync(out)).toEqual(bytes);
    // stdout stays empty in human mode — the file is the output.
    expect(stdout).not.toHaveBeenCalled();
    expect(stderr.mock.calls.map(([line]) => String(line)).join('')).toContain('note.txt');
  });

  it('requests the strict download route with the bearer token, following no redirect', async () => {
    fetchMock.mockResolvedValueOnce(binaryResponse(Buffer.from('x')));

    await build().parseAsync(['attach', 'download', ATTACHMENT_ID, '-o', join(tmpRoot, 'x.bin')], { from: 'user' });

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(`https://wiki.example.com/api/attachments/${ATTACHMENT_ID}/download`);
    expect(init.redirect).toBe('manual');
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer pat-1');
  });

  it('rejects an id that is not an attachment id without making a request', async () => {
    const error = await downloadFailure(['/some/page', '-o', join(tmpRoot, 'x.bin')]);

    expect(error.exitCode).toBe(6);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('refuses a 200 that is not the route’s own answer, and writes no file', async () => {
    // What a captive portal or an SSO gateway returns: a 200 carrying HTML.
    fetchMock.mockResolvedValueOnce(binaryResponse(Buffer.from('<html>sign in</html>'), { contentType: 'text/html; charset=utf-8', disposition: null }));
    const out = join(tmpRoot, 'x.bin');

    const error = await downloadFailure([ATTACHMENT_ID, '-o', out]);

    expect(error.message).toContain('text/html');
    expect(existsSync(out)).toBe(false);
  });

  it('refuses an octet-stream served inline (no attachment disposition)', async () => {
    fetchMock.mockResolvedValueOnce(binaryResponse(Buffer.from('x'), { disposition: 'inline' }));
    const out = join(tmpRoot, 'x.bin');

    await downloadFailure([ATTACHMENT_ID, '-o', out]);

    expect(existsSync(out)).toBe(false);
  });

  it('surfaces a redirect instead of chasing it', async () => {
    const redirect = binaryResponse(Buffer.alloc(0), { status: 302, contentType: null, disposition: null });
    redirect.headers.set('location', 'https://sso.example.com/login');
    fetchMock.mockResolvedValueOnce(redirect);

    const error = await downloadFailure([ATTACHMENT_ID, '-o', join(tmpRoot, 'x.bin')]);

    expect(error.message).toContain('redirected');
    expect(error.message).toContain('https://sso.example.com/login');
  });

  it('maps the route’s FILE_MISSING 404 to a not-found exit code', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(404, { error: { code: 'FILE_MISSING', message: 'The attachment record exists but its stored file is gone' } }),
    );
    const out = join(tmpRoot, 'x.bin');

    const error = await downloadFailure([ATTACHMENT_ID, '-o', out]);

    expect(error.exitCode).toBe(4);
    expect(error.apiCode).toBe('FILE_MISSING');
    expect(existsSync(out)).toBe(false);
  });

  it('deletes the partial file when the body is shorter than Content-Length', async () => {
    // A connection cut mid-transfer. Keeping the partial file would leave
    // something that looks downloaded to everything downstream.
    fetchMock.mockResolvedValueOnce(binaryResponse(Buffer.from('half'), { contentLength: '999' }));
    const out = join(tmpRoot, 'x.bin');

    const error = await downloadFailure([ATTACHMENT_ID, '-o', out]);

    expect(error.message).toContain('truncated');
    expect(existsSync(out)).toBe(false);
  });

  it('rejects --json without -o, since the bytes already own stdout', async () => {
    const error = await downloadFailure([ATTACHMENT_ID], ['--json']);

    expect(error.exitCode).toBe(6);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('emits a JSON summary alongside the file under --json', async () => {
    const bytes = Buffer.from('hello attachment', 'utf8');
    fetchMock.mockResolvedValueOnce(binaryResponse(bytes));
    const out = join(tmpRoot, 'note.txt');

    await build().parseAsync(['--json', 'attach', 'download', ATTACHMENT_ID, '-o', out], { from: 'user' });

    const printed = JSON.parse(stdout.mock.calls.map(([line]) => String(line)).join(''));
    expect(printed).toEqual({ id: ATTACHMENT_ID, path: out, bytes: bytes.length, filename: 'note.txt' });
  });
});
