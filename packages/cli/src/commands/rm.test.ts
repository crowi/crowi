import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { IDEMPOTENCY_KEY_PATTERN } from '@crowi/api-contract';
import { Command } from 'commander';

import { upsertProfile } from '../lib/config';
import { type CliError, EXIT, setRefreshHook } from '../lib/http';
import { registerRm } from './rm';

/**
 * These tests pin the Idempotency-Key header on every `DELETE /pages` path
 * `crowi rm` can take (soft delete, the `--force` retry, `--completely`) —
 * a server enforcing RFC-0021 Phase 2c-2a rejects a soft-delete request
 * that lacks the header with a 400 (the hard-delete branch never reads it,
 * so `--completely` was never affected by that). They also lock down the
 * `--force` retry-scope fix: only `PAGE_REVISION_ERROR` (409) is retried,
 * not `PAGE_TRANSITION_IN_PROGRESS` / `IDEMPOTENCY_KEY_CONFLICT`.
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
  tmpRoot = mkdtempSync(join(tmpdir(), 'crowi-cli-rm-'));
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
  registerRm(program);
  return program;
}

/** All `DELETE /pages` calls, in order, for header/body inspection. */
function deleteCalls(mock: jest.Mock<Promise<Response>, [string, RequestInit]>): RequestInit[] {
  return mock.mock.calls.filter(([, init]) => init.method === 'DELETE').map(([, init]) => init);
}

async function run(args: string[]): Promise<CliError | undefined> {
  return build()
    .parseAsync(['rm', ...args], { from: 'user' })
    .then(
      () => undefined,
      (err: unknown) => err as CliError,
    );
}

describe('crowi rm — idempotency key', () => {
  it('sends an idempotency key on a soft delete', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { page: { _id: 'p1', path: '/a', revision: { _id: 'r1' } } }));
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { page: { _id: 'p1', path: '/trash/a' } }));

    const error = await run(['/a']);

    expect(error).toBeUndefined();
    const [del] = deleteCalls(fetchMock);
    const headers = del.headers as Record<string, string>;
    expect(headers['idempotency-key']).toMatch(IDEMPOTENCY_KEY_PATTERN);
    expect(JSON.parse(del.body as string)).toMatchObject({ page_id: 'p1', completely: false });
  });

  it('reuses the same key for the --force retry', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { page: { _id: 'p1', path: '/a', revision: { _id: 'r1' } } }));
    fetchMock.mockResolvedValueOnce(jsonResponse(409, { error: { code: 'PAGE_REVISION_ERROR', message: 'stale' } }));
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { page: { _id: 'p1', path: '/a', revision: { _id: 'r2' } } }));
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { page: { _id: 'p1', path: '/trash/a' } }));

    const error = await run(['/a', '--force']);

    expect(error).toBeUndefined();
    const calls = deleteCalls(fetchMock);
    expect(calls).toHaveLength(2);
    const [firstDelete, secondDelete] = calls;
    const firstKey = (firstDelete.headers as Record<string, string>)['idempotency-key'];
    const secondKey = (secondDelete.headers as Record<string, string>)['idempotency-key'];
    expect(firstKey).toMatch(IDEMPOTENCY_KEY_PATTERN);
    expect(secondKey).toBe(firstKey);
  });

  it('still sends a key and succeeds with --completely', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { page: { _id: 'p1', path: '/a', revision: { _id: 'r1' } } }));
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { page: { _id: 'p1', path: '/a' } }));

    const error = await run(['/a', '--completely']);

    expect(error).toBeUndefined();
    const [del] = deleteCalls(fetchMock);
    const headers = del.headers as Record<string, string>;
    expect(headers['idempotency-key']).toMatch(IDEMPOTENCY_KEY_PATTERN);
    expect(JSON.parse(del.body as string)).toMatchObject({ completely: true });
    expect(stdout.mock.calls.map(([line]) => String(line)).join('')).toContain('Permanently deleted');
  });

  it.each([
    ['PAGE_TRANSITION_IN_PROGRESS', 'This page is being moved by another operation.', false],
    ['PAGE_TRANSITION_IN_PROGRESS', 'This page is being moved by another operation.', true],
    ['IDEMPOTENCY_KEY_CONFLICT', 'This Idempotency-Key was already used for a different request.', false],
    ['IDEMPOTENCY_KEY_CONFLICT', 'This Idempotency-Key was already used for a different request.', true],
  ])('propagates a %s 409 without refetching or reporting success (force=%s)', async (code, message, force) => {
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { page: { _id: 'p1', path: '/a', revision: { _id: 'r1' } } }));
    fetchMock.mockResolvedValueOnce(jsonResponse(409, { error: { code, message } }));

    const error = await run(force ? ['/a', '--force'] : ['/a']);

    expect(error).toBeDefined();
    expect(error?.apiCode).toBe(code);
    // No re-fetch even with --force: only PAGE_REVISION_ERROR is retried.
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(stdout).not.toHaveBeenCalled();
  });

  it('aborts with EXIT.CONFLICT on a revision conflict without --force', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { page: { _id: 'p1', path: '/a', revision: { _id: 'r1' } } }));
    fetchMock.mockResolvedValueOnce(jsonResponse(409, { error: { code: 'PAGE_REVISION_ERROR', message: 'stale' } }));

    const error = await run(['/a']);

    expect(error).toBeDefined();
    expect(error?.exitCode).toBe(EXIT.CONFLICT);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(stdout).not.toHaveBeenCalled();
  });
});
