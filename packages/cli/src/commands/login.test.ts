import type { Profile } from '../lib/config';
import { setRefreshHook } from '../lib/http';
import { fetchAccount } from './login';

/**
 * After a successful login the CLI does a best-effort one-shot
 * `GET /api/v2/auth/me` to resolve `profile.account`, so `crowi profiles` can
 * show endpoint × user (spec §d). It must NEVER fail login: a flaky /auth/me
 * just leaves the account unset. `fetch` is mocked — no network.
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
  setRefreshHook(undefined);
});

describe('fetchAccount (best-effort /auth/me)', () => {
  it('returns the username from a successful /auth/me', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { user: { id: '1', username: 'alice' } }));
    await expect(fetchAccount(PROFILE)).resolves.toBe('alice');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toBe('https://wiki.example.com/api/v2/auth/me');
  });

  it('returns undefined (never throws) when /auth/me fails with an error status', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(403, { error: { code: 'FORBIDDEN', message: 'nope' } }));
    await expect(fetchAccount(PROFILE)).resolves.toBeUndefined();
  });

  it('returns undefined (never throws) on a network failure', async () => {
    fetchMock.mockRejectedValueOnce(new Error('ECONNREFUSED'));
    await expect(fetchAccount(PROFILE)).resolves.toBeUndefined();
  });

  it('returns undefined when the response omits user.username', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { user: { id: '1' } }));
    await expect(fetchAccount(PROFILE)).resolves.toBeUndefined();
  });
});
