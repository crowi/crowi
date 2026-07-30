import { discover } from './discovery';
import { CliError } from './http';

/**
 * Discovery is the trust root for every subsequent OAuth dial: the CLI fetches
 * the metadata document and then talks to the token/device/revocation URLs it
 * returns. These tests pin those endpoints to the issuer origin (OAuth
 * metadata mix-up defense) and assert the warn-only plaintext-http note.
 * `fetch` is mocked so no network is touched.
 */

type FetchMock = jest.Mock<Promise<Response>, [string, RequestInit]>;

function jsonResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as Response;
}

/** A well-formed discovery document, with the origin-sensitive URLs swappable. */
function discoveryDoc(overrides: Partial<Record<string, string>> = {}): Record<string, unknown> {
  return {
    issuer: 'https://wiki.example.com',
    authorization_endpoint: 'https://web.example.com/oauth/authorize',
    token_endpoint: 'https://wiki.example.com/api/oauth/token',
    revocation_endpoint: 'https://wiki.example.com/api/oauth/revoke',
    device_authorization_endpoint: 'https://wiki.example.com/api/oauth/device',
    scopes_supported: ['pages:read', 'pages:write'],
    response_types_supported: ['code'],
    grant_types_supported: ['authorization_code'],
    code_challenge_methods_supported: ['S256'],
    token_endpoint_auth_methods_supported: ['none'],
    ...overrides,
  };
}

let fetchMock: FetchMock;
const originalFetch = global.fetch;
let stderr: jest.SpyInstance;

beforeEach(() => {
  fetchMock = jest.fn();
  global.fetch = fetchMock as unknown as typeof fetch;
  stderr = jest.spyOn(process.stderr, 'write').mockImplementation(() => true);
});

afterEach(() => {
  global.fetch = originalFetch;
  stderr.mockRestore();
});

describe('discover — origin validation (OAuth metadata mix-up defense)', () => {
  it('accepts a same-origin https discovery document without warning', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(200, discoveryDoc()));
    const endpoints = await discover('https://wiki.example.com');
    expect(endpoints.tokenEndpoint).toBe('https://wiki.example.com/api/oauth/token');
    expect(endpoints.deviceEndpoint).toBe('https://wiki.example.com/api/oauth/device');
    // authorization_endpoint MAY be on a different (web) origin.
    expect(endpoints.authorizeEndpoint).toBe('https://web.example.com/oauth/authorize');
    expect(stderr).not.toHaveBeenCalled();
  });

  it('rejects a token_endpoint on a foreign origin', async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, discoveryDoc({ token_endpoint: 'https://evil.example.net/api/oauth/token' })));
    await expect(discover('https://wiki.example.com')).rejects.toThrow(CliError);
    await expect(discover('https://wiki.example.com')).rejects.toThrow(/issuer origin/);
  });

  it('rejects a revocation_endpoint on a foreign origin', async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, discoveryDoc({ revocation_endpoint: 'https://evil.example.net/api/oauth/revoke' })));
    await expect(discover('https://wiki.example.com')).rejects.toThrow(/issuer origin/);
  });

  it('rejects a device_authorization_endpoint on a foreign origin', async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, discoveryDoc({ device_authorization_endpoint: 'https://evil.example.net/api/oauth/device' })));
    await expect(discover('https://wiki.example.com')).rejects.toThrow(/issuer origin/);
  });

  it('rejects when the metadata issuer origin differs from the user-typed endpoint', async () => {
    // issuer points at one origin but the endpoints live on the (user-typed)
    // server: the endpoint anchor catches the issuer mismatch first.
    fetchMock.mockResolvedValue(jsonResponse(200, discoveryDoc({ issuer: 'https://attacker.example.net' })));
    await expect(discover('https://wiki.example.com')).rejects.toThrow(/does not match the server you are logging into/);
  });

  it('rejects a self-consistent malicious doc on a foreign origin (issuer.origin !== endpoint.origin)', async () => {
    // Every URL — issuer + token/device/revoke — lives on the attacker origin,
    // so issuer-origin pinning ALONE would pass. The endpoint-origin anchor
    // catches it: the user typed wiki.example.com but the doc is foreign.
    const malicious = discoveryDoc({
      issuer: 'https://evil.example.net',
      authorization_endpoint: 'https://evil.example.net/oauth/authorize',
      token_endpoint: 'https://evil.example.net/api/oauth/token',
      revocation_endpoint: 'https://evil.example.net/api/oauth/revoke',
      device_authorization_endpoint: 'https://evil.example.net/api/oauth/device',
    });
    fetchMock.mockResolvedValue(jsonResponse(200, malicious));
    await expect(discover('https://wiki.example.com')).rejects.toThrow(CliError);
    await expect(discover('https://wiki.example.com')).rejects.toThrow(/does not match the server you are logging into/);
  });

  it('passes a legit same-origin doc, still allowing a split-origin authorization_endpoint', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(200, discoveryDoc()));
    const endpoints = await discover('https://wiki.example.com');
    // issuer.origin === endpoint.origin → token/device/revoke all pinned.
    expect(endpoints.tokenEndpoint).toBe('https://wiki.example.com/api/oauth/token');
    // authorization_endpoint may still live on a separate web origin.
    expect(endpoints.authorizeEndpoint).toBe('https://web.example.com/oauth/authorize');
  });

  it('tolerates a trailing slash on the user-typed endpoint when anchoring', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(200, discoveryDoc()));
    const endpoints = await discover('https://wiki.example.com/');
    expect(endpoints.tokenEndpoint).toBe('https://wiki.example.com/api/oauth/token');
  });

  it('allows plaintext http on a loopback host without warning', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(
        200,
        discoveryDoc({
          issuer: 'http://localhost:4301',
          authorization_endpoint: 'http://localhost:4302/oauth/authorize',
          token_endpoint: 'http://localhost:4301/api/oauth/token',
          revocation_endpoint: 'http://localhost:4301/api/oauth/revoke',
          device_authorization_endpoint: 'http://localhost:4301/api/oauth/device',
        }),
      ),
    );
    const endpoints = await discover('http://localhost:4301');
    expect(endpoints.tokenEndpoint).toBe('http://localhost:4301/api/oauth/token');
    expect(stderr).not.toHaveBeenCalled();
  });

  it('warns (warn-only, does not throw) on plaintext http for a non-loopback host', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(
        200,
        discoveryDoc({
          issuer: 'http://wiki.example.com',
          token_endpoint: 'http://wiki.example.com/api/oauth/token',
          revocation_endpoint: 'http://wiki.example.com/api/oauth/revoke',
          device_authorization_endpoint: 'http://wiki.example.com/api/oauth/device',
        }),
      ),
    );
    const endpoints = await discover('http://wiki.example.com');
    expect(endpoints.tokenEndpoint).toBe('http://wiki.example.com/api/oauth/token');
    expect(stderr).toHaveBeenCalledTimes(1);
    expect(String(stderr.mock.calls[0][0])).toContain('plaintext http');
  });
});
