import type { Profile } from './config';
import { apiUrl, authedFetch, CliError, EXIT, setRefreshHook } from './http';

/**
 * The HTTP layer is where version-skew tolerance and edit-conflict exit codes
 * are decided: responses are parsed leniently, the Crowi `{ error: { code,
 * message } }` envelope is mapped to a {@link CliError} with a status-derived
 * exit code, and a 401 triggers a single coalesced refresh + retry. `fetch` is
 * mocked so no network is touched.
 */

type FetchMock = jest.Mock<Promise<Response>, [string, RequestInit]>;

const PROFILE: Profile = {
  alias: 'work',
  endpoint: 'https://wiki.example.com',
  tokens: { accessToken: 'access-1', refreshToken: 'refresh-1' },
};

/** Build a minimal `Response`-like object for the global fetch mock. */
function jsonResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => (body === undefined ? '' : JSON.stringify(body)),
  } as Response;
}

function textResponse(status: number, text: string): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => text,
  } as Response;
}

let fetchMock: FetchMock;
const originalFetch = global.fetch;

beforeEach(() => {
  fetchMock = jest.fn();
  global.fetch = fetchMock as unknown as typeof fetch;
  setRefreshHook(undefined);
});

afterEach(() => {
  global.fetch = originalFetch;
  setRefreshHook(undefined);
});

describe('apiUrl', () => {
  it('prefixes /api/v2 and normalises a missing leading slash', () => {
    expect(apiUrl('https://x.example', 'app/info')).toBe('https://x.example/api/v2/app/info');
    expect(apiUrl('https://x.example/', '/app/info')).toBe('https://x.example/api/v2/app/info');
  });

  it('appends defined query params and skips undefined ones', () => {
    const url = apiUrl('https://x.example', '/search', { q: 'hi', limit: 50, type: undefined });
    expect(url).toBe('https://x.example/api/v2/search?q=hi&limit=50');
  });
});

describe('authedFetch success path', () => {
  it('injects the bearer token and returns the parsed body', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { page: { _id: 'p1' } }));
    const body = await authedFetch<{ page: { _id: string } }>(PROFILE, 'GET', '/pages');
    expect(body.page._id).toBe('p1');
    const [, init] = fetchMock.mock.calls[0];
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer access-1');
  });

  it('serialises a JSON body with the right Content-Type', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(200, {}));
    await authedFetch(PROFILE, 'POST', '/pages', { json: { path: '/x', body: 'b' } });
    const [, init] = fetchMock.mock.calls[0];
    expect(init.body).toBe(JSON.stringify({ path: '/x', body: 'b' }));
    expect((init.headers as Record<string, string>)['Content-Type']).toBe('application/json');
  });

  it('returns undefined for an empty 2xx body', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(204, undefined));
    await expect(authedFetch(PROFILE, 'DELETE', '/pages')).resolves.toBeUndefined();
  });
});

describe('authedFetch error mapping', () => {
  it('maps the Crowi envelope code/message and a 404 to EXIT.NOT_FOUND', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(404, { error: { code: 'PAGE_NOT_FOUND', message: 'no such page' } }));
    await expect(authedFetch(PROFILE, 'GET', '/pages')).rejects.toMatchObject({
      message: 'no such page',
      apiCode: 'PAGE_NOT_FOUND',
      status: 404,
      exitCode: EXIT.NOT_FOUND,
    });
  });

  it('maps 409 to EXIT.CONFLICT carrying the revision code', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(409, { error: { code: 'PAGE_REVISION_ERROR', message: 'stale' } }));
    const err = await authedFetch(PROFILE, 'PUT', '/pages').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CliError);
    expect((err as CliError).exitCode).toBe(EXIT.CONFLICT);
    expect((err as CliError).apiCode).toBe('PAGE_REVISION_ERROR');
  });

  it.each([
    [401, EXIT.UNAUTHENTICATED],
    [403, EXIT.FORBIDDEN],
    [400, EXIT.INVALID],
    [422, EXIT.INVALID],
    [503, EXIT.UNAVAILABLE],
    [500, EXIT.GENERAL],
  ])('maps status %i to the right exit code', async (status, exit) => {
    fetchMock.mockResolvedValueOnce(jsonResponse(status, { error: { message: 'boom' } }));
    const err = (await authedFetch(PROFILE, 'GET', '/x').catch((e: unknown) => e)) as CliError;
    expect(err.exitCode).toBe(exit);
  });

  it('falls back to a raw text body when there is no envelope', async () => {
    fetchMock.mockResolvedValueOnce(textResponse(500, 'upstream exploded'));
    await expect(authedFetch(PROFILE, 'GET', '/x')).rejects.toMatchObject({ message: 'upstream exploded' });
  });

  it('falls back to a status message for an empty error body', async () => {
    fetchMock.mockResolvedValueOnce(textResponse(502, ''));
    await expect(authedFetch(PROFILE, 'GET', '/x')).rejects.toMatchObject({ message: 'request failed with status 502' });
  });

  it('refuses to dial when no server is configured', async () => {
    await expect(authedFetch({ alias: 'x', endpoint: '' }, 'GET', '/x')).rejects.toMatchObject({
      exitCode: EXIT.UNAUTHENTICATED,
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('authedFetch 401 refresh + retry', () => {
  it('refreshes once and retries with the rotated access token', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(401, { error: { message: 'expired' } })).mockResolvedValueOnce(jsonResponse(200, { ok: true }));
    const refresh = jest.fn(async () => 'access-2');
    setRefreshHook(refresh);

    const body = await authedFetch<{ ok: boolean }>(PROFILE, 'GET', '/pages');

    expect(body.ok).toBe(true);
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const [, retryInit] = fetchMock.mock.calls[1];
    expect((retryInit.headers as Record<string, string>).Authorization).toBe('Bearer access-2');
  });

  it('surfaces the 401 when the refresh hook declines (no rotated token)', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(401, { error: { message: 'expired' } }));
    setRefreshHook(async () => undefined);
    await expect(authedFetch(PROFILE, 'GET', '/pages')).rejects.toMatchObject({ exitCode: EXIT.UNAUTHENTICATED });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('does not refresh when there is no refresh token', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(401, { error: { message: 'expired' } }));
    const refresh = jest.fn(async () => 'access-2');
    setRefreshHook(refresh);
    await expect(authedFetch({ ...PROFILE, tokens: { accessToken: 'a' } }, 'GET', '/pages')).rejects.toMatchObject({
      exitCode: EXIT.UNAUTHENTICATED,
    });
    expect(refresh).not.toHaveBeenCalled();
  });
});
