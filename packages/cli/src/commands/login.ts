import type { Command } from 'commander';

import { getGlobalOptions } from '../cli';
import { loadConfig, type Profile, stripTrailingSlash, upsertProfile } from '../lib/config';
import { discover } from '../lib/discovery';
import { authedFetch, CliError, EXIT } from '../lib/http';
import { DEFAULT_SCOPE, loginAuthCode, loginDevice, validateScope } from '../lib/oauth';
import { info } from '../lib/output';
import { markNoSkewProbe } from '../lib/skew';

/** Lenient `GET /api/v2/auth/me` view — only the username is consumed here. */
interface AuthMeResponse {
  user?: { username?: string };
}

/**
 * Best-effort one-shot `GET /api/v2/auth/me` to resolve the signed-in
 * username, so `crowi profiles` can show endpoint × user. Returns `undefined`
 * (never throws) when the call fails — a flaky /auth/me must NOT fail an
 * OAuth login (the tokens were just minted, so they are known-good).
 */
export async function fetchAccount(profile: Profile): Promise<string | undefined> {
  try {
    const body = await authedFetch<AuthMeResponse>(profile, 'GET', '/auth/me');
    return body.user?.username;
  } catch {
    return undefined;
  }
}

/**
 * Validating `GET /api/v2/auth/me` for the `--token` PAT path: a typo'd /
 * invalid PAT must NOT be silently stored as "logged in". Unlike the
 * best-effort {@link fetchAccount}, this THROWS:
 *   - a 401/403 → the token was rejected by the server;
 *   - any transport/network failure → the token couldn't be verified.
 * On success it returns the username so the profile's `account` is populated
 * from the same round-trip.
 */
async function verifyTokenAndFetchAccount(profile: Profile, endpoint: string): Promise<string | undefined> {
  let body: AuthMeResponse;
  try {
    body = await authedFetch<AuthMeResponse>(profile, 'GET', '/auth/me');
  } catch (err) {
    if (err instanceof CliError && (err.status === 401 || err.status === 403)) {
      throw new CliError(`the personal access token was rejected by ${endpoint}`, { exitCode: EXIT.UNAUTHENTICATED });
    }
    throw new CliError(`could not verify the token against ${endpoint}`, { exitCode: EXIT.GENERAL });
  }
  return body.user?.username;
}

interface LoginOptions {
  device?: boolean;
  scope?: string;
  token?: string;
}

/**
 * Default profile alias derived from the server host (so `crowi login
 * https://wiki.example.com` lands a `wiki.example.com` profile without the
 * user naming it). Falls back to `default`.
 */
function deriveAlias(endpoint: string): string {
  try {
    return new URL(endpoint).host || 'default';
  } catch {
    return 'default';
  }
}

/**
 * Detect a likely headless environment (no DISPLAY on Linux, or an SSH
 * session) where opening a browser would silently fail — used to auto-fall
 * back to the device flow.
 */
function isHeadless(): boolean {
  if (process.env.SSH_CONNECTION || process.env.SSH_TTY) return true;
  // On Linux/BSD a missing DISPLAY/WAYLAND_DISPLAY means no GUI; macOS/Windows
  // always have a browser path.
  if (process.platform === 'linux' && !process.env.DISPLAY && !process.env.WAYLAND_DISPLAY) {
    return true;
  }
  return false;
}

/**
 * `crowi login [--device] [--token <pat>] [--scope "<scopes>"] [<url>]`.
 *
 * Resolves the server endpoint (positional arg, `--url`, or the existing
 * profile), runs OAuth discovery, then logs in via:
 *   - `--token <pat>`: store the PAT directly (no OAuth flow).
 *   - `--device` (or auto when headless): Device Authorization Grant.
 *   - default: Authorization Code + PKCE over a loopback server.
 * The resulting tokens + discovery endpoints are persisted to the profile
 * (mode 0600).
 */
export function registerLogin(program: Command): void {
  const cmd = program
    .command('login')
    .description('Sign in to a Crowi server (OAuth) and store the credentials in a profile')
    .argument('[url]', 'base URL of the Crowi server (e.g. https://wiki.example.com)')
    .option('--device', 'use the device authorization grant (headless / no browser)')
    .option('--token <pat>', 'store a pre-issued personal access token instead of running an OAuth flow')
    .option('--scope <scopes>', `space-delimited OAuth scopes (default: "${DEFAULT_SCOPE}")`)
    .action(async (urlArg: string | undefined, options: LoginOptions, command: Command) => {
      const globals = getGlobalOptions(command);
      const config = loadConfig();

      // Resolve the endpoint: positional arg > --url > existing profile.
      const aliasHint = globals.profile;
      const existing = aliasHint
        ? config.profiles[aliasHint]
        : aliasHint === undefined && config.currentProfile
          ? config.profiles[config.currentProfile]
          : undefined;
      const endpointRaw = urlArg ?? globals.url ?? existing?.endpoint;
      if (!endpointRaw) {
        throw new CliError('no server URL — pass it as `crowi login <url>` or via --url', { exitCode: EXIT.INVALID });
      }
      const endpoint = stripTrailingSlash(endpointRaw);
      const alias = aliasHint ?? existing?.alias ?? deriveAlias(endpoint);

      // PAT shortcut: store the token directly, no OAuth flow / discovery.
      if (options.token) {
        const profile: Profile = {
          alias,
          endpoint,
          tokens: { accessToken: options.token },
        };
        // Validate the PAT against /auth/me BEFORE persisting: a typo'd /
        // invalid token must not be silently stored as "logged in". The same
        // round-trip populates the account.
        profile.account = await verifyTokenAndFetchAccount(profile, endpoint);
        upsertProfile(profile);
        info(`Stored personal access token for profile "${alias}" (${endpoint}).`, globals);
        return;
      }

      const scope = validateScope(options.scope ?? DEFAULT_SCOPE);

      info(`Discovering OAuth endpoints at ${endpoint}…`, globals);
      const endpoints = await discover(endpoint);

      const useDevice = options.device === true || isHeadless();
      const tokens = useDevice ? await loginDevice(endpoints, scope, globals) : await loginAuthCode(endpoints, scope, globals);

      const profile: Profile = {
        alias,
        endpoint,
        oauth: endpoints,
        tokens,
      };
      // Best-effort: resolve the account so `crowi profiles` shows the user.
      profile.account = await fetchAccount(profile);
      upsertProfile(profile);

      info(`Logged in to "${alias}" (${endpoint}) with scope: ${tokens.scope ?? scope}.`, globals);
    });
  // Pre-auth: login itself mints the token, so there is nothing to probe with.
  markNoSkewProbe(cmd);
}
