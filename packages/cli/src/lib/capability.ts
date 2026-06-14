import { AppInfoResponseSchema } from '@crowi/api-contract';

import { loadConfig, type Profile, type ResolveProfileOptions, resolveProfile, upsertProfile } from './config';
import { authedFetch } from './http';
import { warn } from './output';

/**
 * Capability detection + version-skew warning for the CLI, sourced from the
 * public `GET /api/v2/app/info` signal (extended in STAGE 1 with
 * `version` / `apiVersion` / `capabilities`).
 *
 * Everything here is WARN-ONLY (LOCKED policy): the CLI never refuses a
 * command purely because of a version/capability mismatch. A command that
 * needs a capability the server lacks degrades to a clear message instead of
 * a raw 404; an old server that omits `version`/`capabilities` is treated as
 * the static baseline with skew warnings suppressed.
 */

/**
 * Capabilities the CLI assumes are present on ANY Crowi 2.0 server, even one
 * that predates capability reporting (so an old server → no false "missing
 * feature" message). Mirrors the server's `staticAlwaysOn` set: these
 * subsystems are unconditionally compiled into `@crowi/api`.
 */
export const STATIC_CAPABILITIES = [
  'oauth',
  'oauth:auth-code',
  'oauth:device',
  'oauth:pkce',
  'pat',
  'pages',
  'comments',
  'bookmarks',
  'attachments',
  'notifications',
] as const;

/** How long a cached `app/info` snapshot is considered fresh (10 minutes). */
const CAPABILITY_TTL_MS = 10 * 60 * 1000;

/**
 * The API surface version this build of the CLI is written against (the
 * "v2 floor"). Used only for a soft skew note — never to refuse a command.
 */
const CLI_API_VERSION = 'v2';

/** Lenient view of the `GET /api/v2/app/info` response. */
interface AppInfo {
  version?: string;
  apiVersion?: string;
  capabilities?: string[];
}

/**
 * Whether the profile's cached capability snapshot is still within the TTL.
 */
function isCacheFresh(profile: Profile): boolean {
  const fetchedAt = profile.capabilitiesFetchedAt;
  if (typeof fetchedAt !== 'number') return false;
  return Date.now() - fetchedAt < CAPABILITY_TTL_MS;
}

/**
 * Fetch `GET /api/v2/app/info` and cache `version` + `capabilities` onto the
 * profile (persisted to `contexts.json`). Returns the resolved info. Failures
 * (network / parse) are swallowed and treated as an old/unknown server: the
 * caller falls back to the static baseline. Skips the round-trip when the
 * cached snapshot is still fresh, unless `force` is set.
 */
export async function fetchAppInfo(profile: Profile, opts: { force?: boolean } = {}): Promise<AppInfo> {
  if (!opts.force && isCacheFresh(profile)) {
    // Return the cached apiVersion too, so warnVersionSkew still fires on a
    // TTL-fresh cache hit (not just on the first uncached fetch).
    return { version: profile.version, apiVersion: profile.apiVersion, capabilities: profile.capabilities };
  }

  let info: AppInfo;
  try {
    const body = await authedFetch<unknown>(profile, 'GET', '/app/info');
    // Lenient parse: an old server omits version/capabilities; tolerate that.
    const parsed = AppInfoResponseSchema.partial().safeParse(body);
    if (parsed.success) {
      info = {
        version: parsed.data.version,
        apiVersion: parsed.data.apiVersion,
        capabilities: parsed.data.capabilities,
      };
    } else {
      info = {};
    }
  } catch {
    // Unreachable server / non-JSON / old route: degrade silently to baseline.
    return { version: profile.version, apiVersion: profile.apiVersion, capabilities: profile.capabilities };
  }

  // Persist the snapshot for the TTL window. Only write when we actually got
  // something back, to avoid clobbering a previous good cache with blanks.
  if (info.version !== undefined || info.apiVersion !== undefined || info.capabilities !== undefined) {
    upsertProfile({
      ...profile,
      version: info.version ?? profile.version,
      apiVersion: info.apiVersion ?? profile.apiVersion,
      capabilities: info.capabilities ?? profile.capabilities,
      capabilitiesFetchedAt: Date.now(),
    });
  }
  return info;
}

/**
 * The effective capability set for a profile: the server-advertised list
 * unioned with the static baseline (so a server that omits a statically
 * always-on capability still reports it as present).
 */
export function effectiveCapabilities(info: AppInfo): Set<string> {
  const set = new Set<string>(STATIC_CAPABILITIES);
  for (const cap of info.capabilities ?? []) {
    set.add(cap);
  }
  return set;
}

/**
 * Whether the server advertises `capability`. An old server (no
 * `capabilities` array) is assumed to have every static baseline capability
 * but none of the dynamically-detected ones (e.g. `search`), so a missing
 * `capabilities` list returns `true` only for the baseline set.
 */
export function hasCapability(info: AppInfo, capability: string): boolean {
  return effectiveCapabilities(info).has(capability);
}

/**
 * Emit a WARN-ONLY version-skew note when the server's `apiVersion` differs
 * from the surface this CLI was built against. Never throws / refuses. An old
 * server that omits `apiVersion` gets a single soft note (suppressed once the
 * snapshot is cached, since we only warn when the field is present and
 * differs). `version`/`apiVersion` absent entirely → no warning.
 */
export function warnVersionSkew(info: AppInfo): void {
  if (info.apiVersion && info.apiVersion !== CLI_API_VERSION) {
    warn(
      `server API surface is "${info.apiVersion}" but this CLI targets "${CLI_API_VERSION}" — ` + `some commands may behave unexpectedly (continuing anyway).`,
    );
  }
}

/**
 * Capability-gate a command. Fetches (cached) `app/info`, and if the server
 * does NOT advertise `capability`, throws nothing — instead returns `false`
 * after printing a clear stderr message, so the caller can short-circuit with
 * a graceful exit rather than firing a request that would 404. Returns `true`
 * when the capability is present (or assumed present for an old server). Also
 * surfaces a version-skew note as a side effect.
 *
 * `humanName` is used in the "not available on this server" message.
 */
export async function ensureCapability(profile: Profile, capability: string, humanName: string): Promise<boolean> {
  const info = await fetchAppInfo(profile);
  warnVersionSkew(info);
  if (!hasCapability(info, capability)) {
    warn(`${humanName} is not available on this server (capability "${capability}" not advertised).`);
    return false;
  }
  return true;
}

/**
 * Best-effort, fire-once version-skew check for the authenticated Phase 1
 * command path (search / get / cat / ls / create / edit / update / mv / rm /
 * watch / whoami). Wired as a commander `preSubcommand` hook so the skew
 * signal is NOT dormant for the core surface — RFC §3.4/§10 and Spec §10
 * scope "per-profile instance version read + skew warning" to Phase 1.
 *
 * Resolves the profile the same way {@link requireProfile} does but NEVER
 * throws: a command run without a usable profile/token (`login`, or a
 * not-signed-in invocation) is silently skipped so the command's own
 * "run `crowi login` first" error stays the visible one. The underlying
 * `fetchAppInfo` is TTL-cached and swallows network failures, so this is
 * cheap enough to run on every authenticated invocation.
 */
export async function maybeWarnVersionSkew(opts: ResolveProfileOptions): Promise<void> {
  try {
    const config = loadConfig();
    const profile = resolveProfile(config, opts);
    // No resolvable profile, or one without a token (e.g. mid-`login`): the
    // command itself will surface the right error — stay silent here.
    if (!profile?.tokens?.accessToken) {
      return;
    }
    const info = await fetchAppInfo(profile);
    warnVersionSkew(info);
  } catch {
    // Best-effort: never let the skew probe break or noise up a command.
  }
}
