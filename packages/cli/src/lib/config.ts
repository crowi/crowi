import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { chmodSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

import type { UploadPolicyResponse } from '@crowi/api-contract';

/**
 * Persisted OAuth tokens for a single profile. The CLI is a PUBLIC OAuth
 * client (PKCE), so there is no client secret to store — only the rotated
 * access / refresh token pair plus the granted scope.
 */
export interface ProfileTokens {
  accessToken?: string;
  refreshToken?: string;
  /** Epoch milliseconds at which `accessToken` expires. */
  expiresAt?: number;
  /** Space-delimited granted scope set returned by the token endpoint. */
  scope?: string;
}

/**
 * Resolved OAuth endpoint URLs for a profile. Discovery
 * (`/.well-known/oauth-authorization-server`) returns these already
 * carrying the correct path prefix (token/revoke/device already include
 * `/api`; authorize is a web page on the issuer origin), so they are
 * cached verbatim and dialled as-is — never reconstructed from `endpoint`.
 */
export interface ProfileEndpoints {
  issuer?: string;
  tokenEndpoint?: string;
  revokeEndpoint?: string;
  deviceEndpoint?: string;
  authorizeEndpoint?: string;
}

/**
 * One named profile (a.k.a. "context"): a server + the account/tokens used
 * to talk to it, plus cached capability/version signals from
 * `GET /api/app/info`.
 */
export interface Profile {
  /** Profile alias, also the key in the `profiles` map. */
  alias: string;
  /** Base URL of the Crowi server, e.g. `https://wiki.example.com`. */
  endpoint: string;
  /** Username of the signed-in account (for display / disambiguation). */
  account?: string;
  tokens?: ProfileTokens;
  oauth?: ProfileEndpoints;
  /** Capabilities advertised by `GET /api/app/info`. */
  capabilities?: string[];
  /** Server api package version from `GET /api/app/info`. */
  version?: string;
  /** Server API-surface version (e.g. `v2`) from `GET /api/app/info`. */
  apiVersion?: string;
  /** Epoch milliseconds when capabilities/version were last fetched. */
  capabilitiesFetchedAt?: number;
  /**
   * Cached `GET /attachments/upload-policy` response (`./upload-policy.ts`).
   * `undefined` = not yet fetched for this profile; `null` = fetched once and
   * 404'd (a server old enough to lack the endpoint) — recorded so we never
   * ask that server again, with no TTL (an old server does not gain the
   * endpoint by CLI-side expiry). A present policy DOES expire, on the same
   * TTL as `capabilities` below (`uploadPolicyFetchedAt`), since the
   * server's actual values can change across a version upgrade and the CLI
   * must eventually pick that up without a per-upload round trip.
   */
  uploadPolicy?: UploadPolicyResponse | null;
  /** Epoch milliseconds when a present (non-null) `uploadPolicy` was fetched. */
  uploadPolicyFetchedAt?: number;
}

/** On-disk shape of `contexts.json`. */
export interface ConfigFile {
  /** Alias of the profile used when `--profile` is not supplied. */
  currentProfile?: string;
  profiles: Record<string, Profile>;
}

const FILE_MODE = 0o600;
const DIR_MODE = 0o700;

/**
 * Alias used for the ephemeral in-memory profile created from `--url` /
 * `--token` (or `$CROWI_URL` / `$CROWI_TOKEN`). An ad-hoc profile is NEVER
 * persisted to `contexts.json`: a one-shot PAT must not leak onto disk. Every
 * write path checks `profile.alias === ADHOC_ALIAS` and no-ops.
 */
export const ADHOC_ALIAS = '(ad-hoc)';

/**
 * Resolve the config directory, honouring `$XDG_CONFIG_HOME` and falling
 * back to `~/.config`. The CLI's files live under `<configHome>/crowi`.
 */
export function configDir(): string {
  const xdg = process.env.XDG_CONFIG_HOME;
  const base = xdg && xdg.trim() !== '' ? xdg : join(homedir(), '.config');
  return join(base, 'crowi');
}

/** Absolute path to the contexts/profiles store. */
export function configPath(): string {
  return join(configDir(), 'contexts.json');
}

const EMPTY_CONFIG: ConfigFile = { profiles: {} };

/**
 * Load the config file. Returns an empty config when the file does not
 * exist yet. Tightens the file permissions to 0600 on read if they have
 * drifted (e.g. a hand-edited file) so tokens are never left world-readable.
 */
export function loadConfig(): ConfigFile {
  const path = configPath();
  if (!existsSync(path)) {
    return { ...EMPTY_CONFIG, profiles: {} };
  }
  // Best-effort permission tightening; ignore failures on platforms /
  // filesystems that don't support chmod.
  try {
    chmodSync(path, FILE_MODE);
  } catch {
    // ignore
  }
  const raw = readFileSync(path, 'utf8');
  if (raw.trim() === '') {
    return { ...EMPTY_CONFIG, profiles: {} };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`failed to parse config at ${path}: ${message}`);
  }
  if (typeof parsed !== 'object' || parsed === null) {
    throw new Error(`config at ${path} is not a JSON object`);
  }
  const obj = parsed as Partial<ConfigFile>;
  return {
    currentProfile: obj.currentProfile,
    profiles: obj.profiles ?? {},
  };
}

/**
 * Persist the config atomically (write to a temp file in the same
 * directory, then rename) with the directory at 0700 and the file at 0600.
 * The rename is atomic on POSIX, so a crash mid-write can never leave a
 * half-written tokens file.
 */
export function saveConfig(config: ConfigFile): void {
  const dir = configDir();
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true, mode: DIR_MODE });
  }
  try {
    chmodSync(dir, DIR_MODE);
  } catch {
    // ignore
  }
  const path = configPath();
  const tmp = join(dirname(path), `.contexts.${process.pid}.${Date.now()}.tmp`);
  const json = `${JSON.stringify(config, null, 2)}\n`;
  // Create the temp file with restrictive permissions from the start so
  // there is no window where the tokens are readable by other users.
  writeFileSync(tmp, json, { mode: FILE_MODE });
  try {
    chmodSync(tmp, FILE_MODE);
  } catch {
    // ignore
  }
  renameSync(tmp, path);
  try {
    chmodSync(path, FILE_MODE);
  } catch {
    // ignore
  }
}

/** Look up a profile by alias. Returns `undefined` when absent. */
export function getProfile(config: ConfigFile, alias: string): Profile | undefined {
  return config.profiles[alias];
}

/** Insert or replace a profile and persist. */
export function upsertProfile(profile: Profile): void {
  const config = loadConfig();
  config.profiles[profile.alias] = profile;
  if (!config.currentProfile) {
    config.currentProfile = profile.alias;
  }
  saveConfig(config);
}

/**
 * Merge `partial` onto the STORED profile and persist, re-reading config
 * first so a concurrent edit (e.g. a token rotation persisted by the refresh
 * hook between command start and this write) is not clobbered. Fields not in
 * `partial` keep their stored value; this is the safe path for writing back
 * cache-only fields (capabilities / version) without carrying possibly-stale
 * in-memory tokens. No-ops when the profile no longer exists on disk.
 */
export function updateProfileFields(alias: string, partial: Partial<Profile>): void {
  const config = loadConfig();
  const stored = config.profiles[alias];
  if (!stored) {
    return;
  }
  config.profiles[alias] = { ...stored, ...partial };
  saveConfig(config);
}

/** Remove a profile (and clear the current pointer if it referenced it). */
export function removeProfile(alias: string): boolean {
  const config = loadConfig();
  if (!(alias in config.profiles)) {
    return false;
  }
  delete config.profiles[alias];
  if (config.currentProfile === alias) {
    config.currentProfile = Object.keys(config.profiles)[0];
  }
  saveConfig(config);
  return true;
}

/**
 * Thrown by {@link setCurrentProfile} when `alias` is not a registered
 * profile. A distinct class (rather than a plain `Error`) so callers can
 * distinguish "no such profile" from every other failure `setCurrentProfile`
 * can raise (config parse error, atomic-write I/O failure, ...) — those must
 * keep surfacing as the CLI's general error (exit 1), not as a not-found.
 */
export class ProfileNotFoundError extends Error {
  constructor(alias: string) {
    super(`no such profile: ${alias}`);
    this.name = 'ProfileNotFoundError';
  }
}

/** Set the current/default profile pointer. */
export function setCurrentProfile(alias: string): void {
  const config = loadConfig();
  // `hasOwnProperty` rather than `in`: `config.profiles` is a plain object
  // parsed from JSON, so `in` would also match inherited `Object.prototype`
  // keys (e.g. alias `"toString"`) and let an unregistered alias become the
  // current profile instead of failing.
  if (!Object.prototype.hasOwnProperty.call(config.profiles, alias)) {
    throw new ProfileNotFoundError(alias);
  }
  config.currentProfile = alias;
  saveConfig(config);
}

/**
 * Options that influence active-profile resolution, sourced from the global
 * CLI flags (`--profile`, `--url`, `--token`).
 */
export interface ResolveProfileOptions {
  /** `--profile <alias>` — pick a stored profile by name. */
  profile?: string;
  /** `--url <baseUrl>` — talk to an ad-hoc server without a stored profile. */
  url?: string;
  /** `--token <accessToken>` — use a bearer token directly (e.g. a PAT). */
  token?: string;
}

/**
 * Resolve the profile a command should act on, honouring (in order):
 *   1. `--url`/`--token` → an ephemeral in-memory profile (never persisted).
 *   2. `--profile <alias>` or `$CROWI_PROFILE`.
 *   3. the stored `currentProfile`.
 *
 * Returns `undefined` when nothing resolves (caller decides whether the
 * command requires auth).
 */
export function resolveProfile(config: ConfigFile, opts: ResolveProfileOptions = {}): Profile | undefined {
  const url = opts.url ?? process.env.CROWI_URL;
  const token = opts.token ?? process.env.CROWI_TOKEN;
  // Ad-hoc target: --url / --token bypass the stored profiles entirely.
  if (url || token) {
    return {
      alias: ADHOC_ALIAS,
      endpoint: stripTrailingSlash(url ?? ''),
      tokens: token ? { accessToken: token } : undefined,
    };
  }
  const alias = opts.profile ?? process.env.CROWI_PROFILE ?? config.currentProfile;
  if (!alias) {
    return undefined;
  }
  return config.profiles[alias];
}

/** Remove a single trailing slash from a base URL, if present. */
export function stripTrailingSlash(url: string): string {
  return url.endsWith('/') ? url.slice(0, -1) : url;
}
