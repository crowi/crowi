import type { Command } from 'commander';

import { getGlobalOptions } from '../cli';
import { loadConfig, type Profile, stripTrailingSlash, upsertProfile } from '../lib/config';
import { discover } from '../lib/discovery';
import { CliError, EXIT } from '../lib/http';
import { DEFAULT_SCOPE, loginAuthCode, loginDevice, validateScope } from '../lib/oauth';
import { info } from '../lib/output';

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
  program
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
      upsertProfile(profile);

      info(`Logged in to "${alias}" (${endpoint}) with scope: ${tokens.scope ?? scope}.`, globals);
    });
}
