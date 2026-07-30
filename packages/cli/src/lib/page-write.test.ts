import type { Profile } from './config';
import { CliError, EXIT, setRefreshHook } from './http';
import { fetchCurrentPage, isRevisionConflict, postPage, putPage } from './page-write';

/**
 * The write helpers are the "v2 floor": they validate outgoing args with the
 * @crowi/api-contract REQUEST schemas before any request leaves the machine,
 * and they classify a 409 so the edit command can choose ABORT vs --force.
 * `fetch` is mocked; the focus is the validation + conflict-classification
 * branching, not the network round-trip.
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
});

describe('isRevisionConflict (409 abort vs --force decision)', () => {
  it('is true for a 409 status', () => {
    expect(isRevisionConflict(new CliError('stale', { status: 409 }))).toBe(true);
  });

  it('is true for the PAGE_REVISION_ERROR api code regardless of status', () => {
    expect(isRevisionConflict(new CliError('stale', { apiCode: 'PAGE_REVISION_ERROR' }))).toBe(true);
  });

  it('is false for other CliErrors', () => {
    expect(isRevisionConflict(new CliError('nope', { status: 404 }))).toBe(false);
  });

  it('is false for non-CliError values', () => {
    expect(isRevisionConflict(new Error('plain'))).toBe(false);
    expect(isRevisionConflict('409')).toBe(false);
    expect(isRevisionConflict(undefined)).toBe(false);
  });
});

describe('putPage validation (v2 floor)', () => {
  it('rejects a non-string page_id via the request schema before hitting the network', async () => {
    // The UpdatePageRequestSchema requires string page_id/body; a wrong type
    // (what a mis-wired caller could send) is rejected client-side.
    await expect(putPage(PROFILE, { pageId: 123 as unknown as string, body: 'x' })).rejects.toMatchObject({
      exitCode: EXIT.INVALID,
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('sends page_id + body + revision_id and returns the new revision', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { page: { _id: 'p1', path: '/x', revision: { _id: 'rev2' } } }));
    const result = await putPage(PROFILE, { pageId: 'p1', body: 'new', revisionId: 'rev1' });
    expect(result).toEqual({ pageId: 'p1', path: '/x', revisionId: 'rev2', created: false });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://wiki.example.com/api/pages');
    expect(init.method).toBe('PUT');
    expect(JSON.parse(init.body as string)).toMatchObject({ page_id: 'p1', body: 'new', revision_id: 'rev1' });
  });

  it('propagates a 409 as a CliError the edit command can classify', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(409, { error: { code: 'PAGE_REVISION_ERROR', message: 'stale' } }));
    const err = await putPage(PROFILE, { pageId: 'p1', body: 'x', revisionId: 'old' }).catch((e: unknown) => e);
    expect(isRevisionConflict(err)).toBe(true);
  });
});

describe('postPage validation (v2 floor)', () => {
  it('rejects a non-string body via the request schema before any request', async () => {
    await expect(postPage(PROFILE, { path: '/n', body: 42 as unknown as string })).rejects.toMatchObject({
      exitCode: EXIT.INVALID,
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('POSTs path + body and marks the result created', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { page: { _id: 'p9', path: '/n', revision: { _id: 'r1' } } }));
    const result = await postPage(PROFILE, { path: '/n', body: 'hello', grant: 1 });
    expect(result).toEqual({ pageId: 'p9', path: '/n', revisionId: 'r1', created: true });
    const [, init] = fetchMock.mock.calls[0];
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body as string)).toMatchObject({ path: '/n', body: 'hello', grant: 1 });
  });
});

describe('fetchCurrentPage', () => {
  it('flattens body + revision id from the populated page', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { page: { _id: 'p1', path: '/x', revision: { _id: 'rev1', body: '# hi' } } }));
    await expect(fetchCurrentPage(PROFILE, '/x')).resolves.toEqual({
      pageId: 'p1',
      path: '/x',
      body: '# hi',
      revisionId: 'rev1',
    });
  });

  it('returns null on a 404 so edit can create-on-save', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(404, { error: { code: 'PAGE_NOT_FOUND', message: 'nope' } }));
    await expect(fetchCurrentPage(PROFILE, '/missing')).resolves.toBeNull();
  });

  it('propagates non-404 errors (e.g. 403 not granted)', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(403, { error: { code: 'PAGE_NOT_GRANTED', message: 'denied' } }));
    await expect(fetchCurrentPage(PROFILE, '/secret')).rejects.toMatchObject({ exitCode: EXIT.FORBIDDEN });
  });

  it('routes a 24-hex arg to page_id and a path arg to path', async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, { page: { _id: 'p1', revision: { _id: 'r', body: '' } } }));
    await fetchCurrentPage(PROFILE, '507f1f77bcf86cd799439011');
    expect(fetchMock.mock.calls[0][0]).toContain('page_id=507f1f77bcf86cd799439011');
    await fetchCurrentPage(PROFILE, 'foo/bar');
    expect(fetchMock.mock.calls[1][0]).toContain('path=%2Ffoo%2Fbar');
  });
});
