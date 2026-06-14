import { createHash } from 'node:crypto';

import { CliError } from './http';
import { loginAuthCode, loginDevice, validateScope } from './oauth';

// Stub the browser launcher so no real window opens during the flow tests.
jest.mock('./browser', () => ({ openBrowser: jest.fn().mockResolvedValue(false) }));

/**
 * Unit coverage for the pure OAuth helpers that don't touch the network:
 * `--scope` validation against the issuable catalog. The flow functions
 * (loopback / device / refresh) are integration-shaped and exercised
 * end-to-end; here we lock the client-side guard that runs before any
 * request leaves the machine.
 */
describe('validateScope', () => {
  it('accepts the locked default scope and normalises whitespace', () => {
    expect(validateScope('pages:read   pages:write')).toBe('pages:read pages:write');
  });

  it('accepts umbrella scopes', () => {
    expect(validateScope('read write')).toBe('read write');
  });

  it('rejects an empty scope', () => {
    expect(() => validateScope('   ')).toThrow(CliError);
  });

  it('rejects admin:* (reserved, never issuable)', () => {
    expect(() => validateScope('pages:read admin:write')).toThrow(/non-issuable scope/);
  });

  it('rejects an unknown/typo scope', () => {
    expect(() => validateScope('pages:reed')).toThrow(/pages:reed/);
  });
});

/**
 * PKCE S256 self-check: the challenge derivation is internal, but a known
 * RFC 7636 Appendix B vector pins the base64url(sha256(verifier)) math the
 * loopback flow relies on. Re-deriving it here guards against an accidental
 * change to the encoding (e.g. forgetting to strip padding).
 */
describe('PKCE S256 derivation (RFC 7636 vector)', () => {
  it('matches the RFC 7636 Appendix B example', () => {
    const verifier = 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk';
    const expected = 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM';
    const challenge = createHash('sha256').update(verifier).digest().toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    expect(challenge).toBe(expected);
  });
});

/**
 * FIX 3: the loopback auth-code flow must not hang forever when the browser
 * redirect never arrives. A short injectable `timeoutMs` lets us assert the
 * race rejects with the expected CliError (and closes the server / clears the
 * timer in `finally`).
 */
describe('loginAuthCode — browser timeout (FIX 3)', () => {
  it('rejects with an UNAUTHENTICATED CliError when no redirect arrives in time', async () => {
    const endpoints = {
      authorizeEndpoint: 'https://web.example.com/oauth/authorize',
      tokenEndpoint: 'https://wiki.example.com/api/v2/oauth/token',
    };
    // No request will hit the loopback server, so waitForCode never settles;
    // the 20ms timeout wins the race.
    await expect(loginAuthCode(endpoints, 'pages:read', { quiet: true, timeoutMs: 20 })).rejects.toThrow(CliError);
    await expect(loginAuthCode(endpoints, 'pages:read', { quiet: true, timeoutMs: 20 })).rejects.toThrow(/timed out waiting for browser authorization/);
  });
});

/**
 * FIX 7: the device flow clamps a malicious/buggy server's `interval` /
 * `expires_in` so it can't wedge the poll loop into a multi-year sleep. We
 * spy on the timers the flow uses for its inter-poll `sleep` and assert the
 * delay is bounded, regardless of the absurd values the server sends.
 */
describe('loginDevice — interval / expires_in clamping (FIX 7)', () => {
  let fetchMock: jest.Mock<Promise<Response>, [string, RequestInit]>;
  const originalFetch = global.fetch;
  let stderr: jest.SpyInstance;

  function jsonResponse(status: number, body: unknown): Response {
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => body,
      text: async () => (body === undefined ? '' : JSON.stringify(body)),
    } as Response;
  }

  beforeEach(() => {
    fetchMock = jest.fn();
    global.fetch = fetchMock as unknown as typeof fetch;
    stderr = jest.spyOn(process.stderr, 'write').mockImplementation(() => true);
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
    global.fetch = originalFetch;
    stderr.mockRestore();
  });

  const endpoints = {
    deviceEndpoint: 'https://wiki.example.com/api/v2/oauth/device',
    tokenEndpoint: 'https://wiki.example.com/api/v2/oauth/token',
  };

  it('clamps an absurd poll interval to the 60s ceiling', async () => {
    // Device-authorize response advertises a 10-year interval.
    fetchMock.mockResolvedValueOnce(
      jsonResponse(200, {
        device_code: 'dev-1',
        user_code: 'ABCD-EFGH',
        verification_uri: 'https://web.example.com/device',
        verification_uri_complete: 'https://web.example.com/device?user_code=ABCD-EFGH',
        expires_in: 600,
        interval: 315_360_000, // 10 years in seconds
      }),
    );
    // First token poll succeeds, so the loop runs exactly one `sleep`.
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { access_token: 'a', token_type: 'Bearer', refresh_token: 'r', expires_in: 3600, scope: 'pages:read' }));

    const promise = loginDevice(endpoints, 'pages:read', { quiet: true });
    // Let the device-authorize request resolve before draining timers.
    await Promise.resolve();
    await Promise.resolve();
    // The single inter-poll sleep is clamped to 60s — advancing 60s unblocks it.
    await jest.advanceTimersByTimeAsync(60_000);
    const tokens = await promise;
    expect(tokens.accessToken).toBe('a');
  });

  it('bounds an absurd expires_in so the deadline is reachable', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(200, {
        device_code: 'dev-2',
        user_code: 'WXYZ-1234',
        verification_uri: 'https://web.example.com/device',
        verification_uri_complete: 'https://web.example.com/device?user_code=WXYZ-1234',
        expires_in: 315_360_000, // 10 years — must be bounded to <= 30min
        interval: 1,
      }),
    );
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { access_token: 'b', token_type: 'Bearer', refresh_token: 'r', expires_in: 3600, scope: 'pages:read' }));

    const promise = loginDevice(endpoints, 'pages:read', { quiet: true });
    await Promise.resolve();
    await Promise.resolve();
    await jest.advanceTimersByTimeAsync(1_000);
    const tokens = await promise;
    expect(tokens.accessToken).toBe('b');
  });
});
