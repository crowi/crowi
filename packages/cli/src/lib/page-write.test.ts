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

/**
 * RFC-0020 §C-1 — `contentType` rides `X-Crowi-Page-Content-Type`, never
 * the JSON body (`CreatePageRequestSchema` / `UpdatePageRequestSchema` have
 * no `content_type` field, so it would be silently dropped by the server's
 * non-strict zod schema either way — the header is what actually carries
 * the declaration).
 */
describe('putPage / postPage — content_type header (RFC-0020 §C-1)', () => {
  it('putPage adds the header when contentType is given', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { page: { _id: 'p1', path: '/x', revision: { _id: 'rev2' } } }));
    await putPage(PROFILE, { pageId: 'p1', body: 'new', revisionId: 'rev1', contentType: 'artifact' });
    const [, init] = fetchMock.mock.calls[0];
    expect((init.headers as Record<string, string>)['X-Crowi-Page-Content-Type']).toBe('artifact');
    expect(JSON.parse(init.body as string)).not.toHaveProperty('contentType');
    expect(JSON.parse(init.body as string)).not.toHaveProperty('content_type');
  });

  it('putPage sends no header when contentType is omitted', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { page: { _id: 'p1', path: '/x', revision: { _id: 'rev2' } } }));
    await putPage(PROFILE, { pageId: 'p1', body: 'new', revisionId: 'rev1' });
    const [, init] = fetchMock.mock.calls[0];
    expect((init.headers as Record<string, string> | undefined)?.['X-Crowi-Page-Content-Type']).toBeUndefined();
  });

  it('postPage adds the header when contentType is given, and none when omitted', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { page: { _id: 'p9', path: '/n', revision: { _id: 'r1' } } }));
    await postPage(PROFILE, { path: '/n', body: 'hello', contentType: 'markdown' });
    const [, init] = fetchMock.mock.calls[0];
    expect((init.headers as Record<string, string>)['X-Crowi-Page-Content-Type']).toBe('markdown');
    expect(JSON.parse(init.body as string)).not.toHaveProperty('contentType');

    fetchMock.mockResolvedValueOnce(jsonResponse(200, { page: { _id: 'p10', path: '/n2', revision: { _id: 'r2' } } }));
    await postPage(PROFILE, { path: '/n2', body: 'hello' });
    const [, init2] = fetchMock.mock.calls[1];
    expect((init2.headers as Record<string, string> | undefined)?.['X-Crowi-Page-Content-Type']).toBeUndefined();
  });

  it('an artifact write rejection is classified as a CliError with EXIT.INVALID and the formatted message', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(400, {
        error: {
          code: 'ARTIFACT_WRITE_REJECTED',
          reason: 'SCRIPT_TYPE_FORBIDDEN',
          ruleId: 'AI-R13',
          message: 'This script type is not allowed in an artifact page.',
          target: 'script[type]',
        },
      }),
    );
    const err = await postPage(PROFILE, { path: '/n', body: '<html></html>', contentType: 'artifact' }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CliError);
    expect((err as CliError).exitCode).toBe(EXIT.INVALID);
    expect((err as CliError).message).toContain('AI-R13 / SCRIPT_TYPE_FORBIDDEN');
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

  // RFC-0020 §R — the selected revision's own contentType is authoritative;
  // the page-level contentType is only a fallback hint (used below by the
  // no-populated-revision case).
  it('reads contentType from the populated revision', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(200, {
        page: { _id: 'p1', path: '/x', contentType: 'markdown', revision: { _id: 'rev1', body: '<html></html>', contentType: 'artifact' } },
      }),
    );
    await expect(fetchCurrentPage(PROFILE, '/x')).resolves.toMatchObject({ contentType: 'artifact' });
  });

  it('falls back to the page-level contentType hint when the response has no populated revision', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { page: { _id: 'p1', path: '/x', contentType: 'artifact' } }));
    await expect(fetchCurrentPage(PROFILE, '/x')).resolves.toMatchObject({ contentType: 'artifact' });
  });
});
