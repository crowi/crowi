import { loadConfig, type Profile, upsertProfile } from './config';
import { setRefreshHook } from './http';
import { refreshTokens } from './oauth';

/**
 * Single in-flight refresh promise per process, keyed by profile alias, so
 * concurrent 401s on the same profile coalesce onto one `refresh_token`
 * grant. Mirrors `acquireRefreshedToken` in
 * packages/web/src/lib/api-client.ts.
 */
const inFlight = new Map<string, Promise<string | undefined>>();

async function performRefresh(profile: Profile): Promise<string | undefined> {
  const tokenEndpoint = profile.oauth?.tokenEndpoint;
  const refreshToken = profile.tokens?.refreshToken;
  if (!tokenEndpoint || !refreshToken) {
    return undefined;
  }

  const rotated = await refreshTokens(tokenEndpoint, refreshToken);
  if (!rotated) {
    return undefined;
  }

  // Persist the rotated tokens against the *stored* profile (re-read so we
  // don't clobber concurrent edits), but only for a real (named) profile —
  // ad-hoc `--url`/`--token` profiles are never persisted.
  if (profile.alias && profile.alias !== '(ad-hoc)') {
    const config = loadConfig();
    const stored = config.profiles[profile.alias] ?? profile;
    upsertProfile({ ...stored, tokens: rotated });
  }

  return rotated.accessToken;
}

/**
 * Register the 401→refresh→retry hook with the HTTP layer. Called once at
 * CLI startup. The hook coalesces concurrent refreshes per profile, persists
 * the rotated tokens, and returns the new access token (or `undefined` when
 * refresh is impossible, so the 401 surfaces as "session expired").
 */
export function installRefreshHook(): void {
  setRefreshHook((profile) => {
    const key = profile.alias || profile.endpoint;
    const existing = inFlight.get(key);
    if (existing) {
      return existing;
    }
    const promise = performRefresh(profile).finally(() => {
      inFlight.delete(key);
    });
    inFlight.set(key, promise);
    return promise;
  });
}
