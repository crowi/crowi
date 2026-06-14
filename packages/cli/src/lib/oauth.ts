import { createHash, randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';

import { DEVICE_CODE_GRANT_TYPE, DeviceAuthorizeResponseSchema, isIssuableScope, TokenResponseSchema } from '@crowi/api-contract';

import type { ProfileEndpoints, ProfileTokens } from './config';
import { CliError, EXIT } from './http';
import { info } from './output';

/**
 * OAuth 2.0 client for the Crowi CLI, kept INSIDE @crowi/cli for v1 (no
 * separate library). The CLI is the first-party PUBLIC client `crowi-cli`
 * (PKCE-only, no client secret), already seeded server-side with loopback
 * redirect hosts `http://127.0.0.1` + `http://localhost` and the ephemeral
 * port matched at request time (RFC 8252).
 *
 * Three login flows are supported:
 *   - Authorization Code + PKCE (S256) over an ephemeral loopback server
 *     (the default; opens the system browser).
 *   - Device Authorization Grant (RFC 8628) for headless / no-browser hosts.
 *   - A pre-issued Personal Access Token stored directly.
 *
 * plus the `refresh_token` grant (401 → refresh → retry) and RFC 7009 revoke.
 */

/** First-party PUBLIC client_id seeded server-side (RFC-0010). */
export const CLIENT_ID = 'crowi-cli';

/** LOCKED default login scope; `--scope` overrides. */
export const DEFAULT_SCOPE = 'pages:read pages:write';

/**
 * Validate a space-delimited `--scope` string against the issuable catalog.
 * Throws a {@link CliError} listing any tokens outside `ISSUABLE_SCOPES`
 * (e.g. `admin:*` or a typo) before any network call.
 */
export function validateScope(scope: string): string {
  const tokens = scope.split(/\s+/).filter((t) => t.length > 0);
  if (tokens.length === 0) {
    throw new CliError('scope must not be empty', { exitCode: EXIT.INVALID });
  }
  const invalid = tokens.filter((t) => !isIssuableScope(t));
  if (invalid.length > 0) {
    throw new CliError(`unknown / non-issuable scope(s): ${invalid.join(', ')}`, { exitCode: EXIT.INVALID });
  }
  return tokens.join(' ');
}

/** PKCE code-verifier: 43–128 chars of unreserved characters (RFC 7636). */
function generateVerifier(): string {
  // 32 random bytes → 43 base64url chars (within the 43–128 range).
  return base64url(randomBytes(32));
}

/** PKCE S256 challenge = base64url(sha256(verifier)). */
function challengeS256(verifier: string): string {
  return base64url(createHash('sha256').update(verifier).digest());
}

/** RFC 4648 §5 base64url encoding without padding. */
function base64url(buf: Buffer): string {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** Open a URL in the system browser; resolves false if `open` is unavailable. */
async function openBrowser(url: string): Promise<boolean> {
  try {
    // `open` is ESM-only and externalised under the CJS build — load it
    // lazily via dynamic import() rather than a top-level require().
    const mod = (await import('open')) as { default: (target: string) => Promise<unknown> };
    await mod.default(url);
    return true;
  } catch {
    return false;
  }
}

/** Build a `Bearer` token-endpoint POST body as form-encoded (RFC 6749). */
function formBody(params: Record<string, string>): string {
  return new URLSearchParams(params).toString();
}

/**
 * The `error`/`error_description` envelope from the OAuth endpoints
 * (RFC 6749 §5.2 / RFC 8628 §3.5) — distinct from Crowi's
 * `{ error: { code, message } }`.
 */
interface OAuthErrorEnvelope {
  error?: string;
  error_description?: string;
}

function parseOAuthError(body: unknown): OAuthErrorEnvelope | undefined {
  if (typeof body !== 'object' || body === null) return undefined;
  const env = body as OAuthErrorEnvelope;
  if (typeof env.error !== 'string') return undefined;
  return { error: env.error, error_description: env.error_description };
}

/**
 * POST to the token endpoint and return either the parsed
 * {@link OAuthErrorEnvelope} (on a non-2xx with an OAuth error body) or the
 * validated {@link TokenResponseSchema} payload. The device-poll loop uses
 * the error branch to react to `authorization_pending` / `slow_down`.
 */
async function postToken(
  tokenEndpoint: string,
  params: Record<string, string>,
): Promise<{ ok: true; tokens: ProfileTokens } | { ok: false; error: OAuthErrorEnvelope }> {
  let response: Response;
  try {
    response = await fetch(tokenEndpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
      body: formBody(params),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new CliError(`token request failed: ${message}`, { exitCode: EXIT.GENERAL });
  }

  const body: unknown = await response.json().catch(() => undefined);

  if (!response.ok) {
    const oauthErr = parseOAuthError(body);
    if (oauthErr) {
      return { ok: false, error: oauthErr };
    }
    throw new CliError(`token request failed with status ${response.status}`, { exitCode: EXIT.GENERAL, status: response.status });
  }

  const parsed = TokenResponseSchema.safeParse(body);
  if (!parsed.success) {
    throw new CliError('token endpoint returned a malformed response', { exitCode: EXIT.GENERAL });
  }
  return { ok: true, tokens: tokensFromResponse(parsed.data) };
}

/** Map a token-endpoint success body to the persisted {@link ProfileTokens}. */
function tokensFromResponse(data: { access_token: string; refresh_token: string; expires_in: number; scope: string }): ProfileTokens {
  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token,
    expiresAt: Date.now() + data.expires_in * 1000,
    scope: data.scope,
  };
}

/** A throwable for the OAuth error envelope, mapped to an exit code. */
function oauthError(env: OAuthErrorEnvelope): CliError {
  const detail = env.error_description ? `: ${env.error_description}` : '';
  return new CliError(`${env.error}${detail}`, { exitCode: EXIT.UNAUTHENTICATED, apiCode: env.error });
}

// ---------------------------------------------------------------------------
// Authorization Code + PKCE (loopback) flow
// ---------------------------------------------------------------------------

/** Random URL-safe state for CSRF protection of the auth-code redirect. */
function generateState(): string {
  return base64url(randomBytes(16));
}

/**
 * Spin up an ephemeral HTTP server on 127.0.0.1:<random port>, hand back the
 * port + a promise that resolves with the `code` once the browser hits the
 * redirect (validating `state`). The server closes after the first request.
 */
function startLoopbackServer(expectedState: string): Promise<{ redirectUri: string; waitForCode: Promise<string>; close: () => void }> {
  return new Promise((resolve, reject) => {
    let settleCode: (code: string) => void;
    let failCode: (err: Error) => void;
    const waitForCode = new Promise<string>((res, rej) => {
      settleCode = res;
      failCode = rej;
    });

    const server = createServer((req, res) => {
      const reqUrl = new URL(req.url ?? '/', 'http://127.0.0.1');
      const code = reqUrl.searchParams.get('code');
      const state = reqUrl.searchParams.get('state');
      const error = reqUrl.searchParams.get('error');

      const finish = (statusCode: number, message: string) => {
        res.writeHead(statusCode, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(
          `<!doctype html><html><body style="font-family:system-ui;padding:2rem"><h1>${message}</h1><p>You can close this window and return to the terminal.</p></body></html>`,
        );
      };

      if (error) {
        finish(400, 'Authorization failed');
        failCode(new CliError(`authorization denied: ${error}`, { exitCode: EXIT.UNAUTHENTICATED }));
        return;
      }
      if (!code) {
        // Ignore favicon / stray requests without a code.
        finish(404, 'Waiting for authorization…');
        return;
      }
      if (state !== expectedState) {
        finish(400, 'Authorization failed');
        failCode(new CliError('authorization state mismatch (possible CSRF) — aborting', { exitCode: EXIT.UNAUTHENTICATED }));
        return;
      }
      finish(200, 'Login complete');
      settleCode(code);
    });

    server.on('error', (err) => reject(err));

    // Port 0 → OS assigns an ephemeral port; host 127.0.0.1 per RFC 8252.
    server.listen(0, '127.0.0.1', () => {
      const address = server.address() as AddressInfo;
      const redirectUri = `http://127.0.0.1:${address.port}`;
      resolve({
        redirectUri,
        waitForCode,
        close: () => server.close(),
      });
    });
  });
}

/**
 * Run the Authorization Code + PKCE loopback flow: start a loopback server,
 * open the authorize URL in the browser, wait for the redirect carrying the
 * code, then exchange it at the token endpoint. Returns the granted tokens.
 *
 * @param endpoints - resolved discovery endpoints (authorize + token URLs).
 * @param scope     - validated space-delimited scope string.
 */
export async function loginAuthCode(
  endpoints: Pick<ProfileEndpoints, 'authorizeEndpoint' | 'tokenEndpoint'>,
  scope: string,
  opts: { quiet?: boolean },
): Promise<ProfileTokens> {
  const authorizeEndpoint = endpoints.authorizeEndpoint;
  const tokenEndpoint = endpoints.tokenEndpoint;
  if (!authorizeEndpoint || !tokenEndpoint) {
    throw new CliError('discovery did not return the authorize/token endpoints', { exitCode: EXIT.GENERAL });
  }

  const verifier = generateVerifier();
  const challenge = challengeS256(verifier);
  const state = generateState();

  const { redirectUri, waitForCode, close } = await startLoopbackServer(state);

  try {
    const authorizeUrl = new URL(authorizeEndpoint);
    authorizeUrl.searchParams.set('response_type', 'code');
    authorizeUrl.searchParams.set('client_id', CLIENT_ID);
    authorizeUrl.searchParams.set('redirect_uri', redirectUri);
    authorizeUrl.searchParams.set('scope', scope);
    authorizeUrl.searchParams.set('state', state);
    authorizeUrl.searchParams.set('code_challenge', challenge);
    authorizeUrl.searchParams.set('code_challenge_method', 'S256');

    const opened = await openBrowser(authorizeUrl.toString());
    if (opened) {
      info('Opening your browser to complete sign-in…', opts);
    }
    info(`If the browser did not open, visit:\n  ${authorizeUrl.toString()}`, opts);

    const code = await waitForCode;

    const result = await postToken(tokenEndpoint, {
      grant_type: 'authorization_code',
      code,
      code_verifier: verifier,
      redirect_uri: redirectUri,
      client_id: CLIENT_ID,
    });
    if (!result.ok) {
      throw oauthError(result.error);
    }
    return result.tokens;
  } finally {
    close();
  }
}

// ---------------------------------------------------------------------------
// Device Authorization Grant (RFC 8628)
// ---------------------------------------------------------------------------

/** Default device-poll interval (s) when the server omits `interval`. */
const DEFAULT_DEVICE_INTERVAL = 5;
/** `slow_down` bumps the interval by this many seconds (RFC 8628 §3.5). */
const SLOW_DOWN_INCREMENT = 5;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Run the Device Authorization Grant: request a device + user code, show the
 * user where to verify (opening the completed verification URI when a browser
 * is available), then poll the token endpoint honouring `interval`,
 * `authorization_pending`, and `slow_down` until tokens are issued or the
 * code expires / is denied.
 *
 * @param endpoints - resolved discovery endpoints (device + token URLs).
 * @param scope     - validated space-delimited scope string.
 */
export async function loginDevice(
  endpoints: Pick<ProfileEndpoints, 'deviceEndpoint' | 'tokenEndpoint'>,
  scope: string,
  opts: { quiet?: boolean },
): Promise<ProfileTokens> {
  const deviceEndpoint = endpoints.deviceEndpoint;
  const tokenEndpoint = endpoints.tokenEndpoint;
  if (!deviceEndpoint || !tokenEndpoint) {
    throw new CliError('this server does not advertise the device authorization endpoint', { exitCode: EXIT.GENERAL });
  }

  let authResponse: Response;
  try {
    authResponse = await fetch(deviceEndpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ client_id: CLIENT_ID, scope }),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new CliError(`device authorization request failed: ${message}`, { exitCode: EXIT.GENERAL });
  }

  const authBody: unknown = await authResponse.json().catch(() => undefined);
  if (!authResponse.ok) {
    const oauthErr = parseOAuthError(authBody);
    if (oauthErr) throw oauthError(oauthErr);
    throw new CliError(`device authorization failed with status ${authResponse.status}`, { exitCode: EXIT.GENERAL, status: authResponse.status });
  }

  const parsed = DeviceAuthorizeResponseSchema.safeParse(authBody);
  if (!parsed.success) {
    throw new CliError('device authorization endpoint returned a malformed response', { exitCode: EXIT.GENERAL });
  }
  const device = parsed.data;

  // Show the user the code + URL. Always print to stderr (even under --quiet
  // would hide it, so use a plain stderr write via info but it's essential —
  // print verification instructions unconditionally).
  process.stderr.write(`\nTo sign in, visit:\n  ${device.verification_uri}\nand enter the code:\n  ${device.user_code}\n\n`);
  const opened = await openBrowser(device.verification_uri_complete);
  if (opened) {
    info('Opened your browser to the verification page…', opts);
  }

  const deadline = Date.now() + device.expires_in * 1000;
  let interval = (device.interval > 0 ? device.interval : DEFAULT_DEVICE_INTERVAL) * 1000;

  // Poll until tokens, expiry, or a terminal error.
  for (;;) {
    if (Date.now() >= deadline) {
      throw new CliError('device code expired before authorization completed — run `crowi login --device` again', { exitCode: EXIT.UNAUTHENTICATED });
    }
    await sleep(interval);

    const result = await postToken(tokenEndpoint, {
      grant_type: DEVICE_CODE_GRANT_TYPE,
      device_code: device.device_code,
      client_id: CLIENT_ID,
    });
    if (result.ok) {
      return result.tokens;
    }
    switch (result.error.error) {
      case 'authorization_pending':
        // Keep polling at the current interval.
        break;
      case 'slow_down':
        interval += SLOW_DOWN_INCREMENT * 1000;
        break;
      default:
        // expired_token / access_denied / anything else → abort.
        throw oauthError(result.error);
    }
  }
}

// ---------------------------------------------------------------------------
// refresh_token grant + revoke
// ---------------------------------------------------------------------------

/**
 * Exchange a refresh token for a fresh access/refresh pair. Returns the
 * rotated {@link ProfileTokens}, or `undefined` when the refresh token is
 * rejected (invalid_grant) so the caller can fall back to "please log in
 * again" rather than crash.
 */
export async function refreshTokens(tokenEndpoint: string, refreshToken: string): Promise<ProfileTokens | undefined> {
  const result = await postToken(tokenEndpoint, {
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
    client_id: CLIENT_ID,
  });
  if (result.ok) {
    return result.tokens;
  }
  // A rejected refresh token (invalid_grant) is non-fatal here: the caller
  // surfaces "session expired, run `crowi login`".
  return undefined;
}

/**
 * Revoke a token (RFC 7009). Always resolves — revocation is best-effort and
 * the server returns 200 even for unknown tokens — so `crowi logout` never
 * fails just because the network is down or the token was already invalid.
 */
export async function revokeToken(revokeEndpoint: string, token: string): Promise<void> {
  try {
    await fetch(revokeEndpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
      body: formBody({ token, client_id: CLIENT_ID }),
    });
  } catch {
    // best-effort
  }
}
