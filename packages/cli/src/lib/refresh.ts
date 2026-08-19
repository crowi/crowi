import { ADHOC_ALIAS, loadConfig, type Profile, upsertProfile } from './config';
import { setRefreshHook } from './http';
import { refreshTokens } from './oauth';

/**
 * Single in-flight refresh promise per process, keyed by profile alias, so
 * concurrent 401s on the same profile coalesce onto one `refresh_token`
 * grant. Mirrors `acquireRefreshedToken` in
 * packages/web/src/lib/api-client.ts.
 */
const inFlight = new Map<string, Promise<string | undefined>>();

/**
 * How many times to re-check the persisted profile for the winner's rotated
 * token, and the delay between checks. A concurrent race's loser can lose
 * even a single immediate re-read: its own HTTP round-trip is lighter than
 * the winner's (no successor-token DB write on the server side), so its
 * response can arrive before the winner has finished its own local disk
 * write. Spreading the re-read over a few checks closes that gap. Bounded,
 * not a loop: if the stored token is genuinely unchanged after every
 * attempt, the failure is real and we give up — an unbounded loop would
 * spin forever on a token that is actually dead (spec §D-3).
 */
const REREAD_ATTEMPTS = 3;
const REREAD_DELAY_MS = 150;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Persist rotated tokens against the *stored* profile, but only for a real (named) profile — ad-hoc `--url`/`--token` profiles are never persisted. */
function persistIfNamed(profile: Profile, tokens: Profile['tokens']): void {
  if (!profile.alias || profile.alias === ADHOC_ALIAS) {
    return;
  }
  const config = loadConfig();
  const stored = config.profiles[profile.alias] ?? profile;
  upsertProfile({ ...stored, tokens });
}

async function performRefresh(profile: Profile): Promise<string | undefined> {
  const tokenEndpoint = profile.oauth?.tokenEndpoint;
  const refreshToken = profile.tokens?.refreshToken;
  if (!tokenEndpoint || !refreshToken) {
    return undefined;
  }

  const rotated = await refreshTokens(tokenEndpoint, refreshToken);
  if (rotated) {
    persistIfNamed(profile, rotated);
    return rotated.accessToken;
  }

  // The refresh failed with the token we had in memory. Under the server's
  // rotation + reuse-detection scheme (spec §D-3) a concurrent process may
  // have already won this exact race and rotated `refreshToken` to a
  // successor before we presented it — re-read the persisted profile and,
  // if its stored refresh token differs from the one we just presented, the
  // winner already wrote it: retry once with it. The re-read is bounded
  // (REREAD_ATTEMPTS over REREAD_DELAY_MS apart) to close the gap where the
  // winner hasn't finished its own local disk write yet, but the network
  // retry itself happens at most once: if the stored token is still
  // unchanged after every re-read attempt, the failure is real (the chain
  // is actually dead), and retrying the grant again would just loop on the
  // same 400 forever.
  if (!profile.alias || profile.alias === ADHOC_ALIAS) {
    return undefined;
  }
  let stored: Profile | undefined;
  let storedRefreshToken: string | undefined;
  for (let attempt = 0; attempt < REREAD_ATTEMPTS; attempt++) {
    const config = loadConfig();
    stored = config.profiles[profile.alias];
    storedRefreshToken = stored?.tokens?.refreshToken;
    if (storedRefreshToken && storedRefreshToken !== refreshToken) {
      break;
    }
    if (attempt < REREAD_ATTEMPTS - 1) {
      await sleep(REREAD_DELAY_MS);
    }
  }
  if (!stored || !storedRefreshToken || storedRefreshToken === refreshToken) {
    return undefined;
  }

  const retried = await refreshTokens(tokenEndpoint, storedRefreshToken);
  if (!retried) {
    return undefined;
  }
  // Re-persist via `persistIfNamed`, which re-reads the profile fresh right
  // before writing, rather than writing back the `stored` snapshot captured
  // before this network round-trip. Between that snapshot and here, a third
  // concurrent process could have updated unrelated profile fields (account,
  // capabilities, ...); writing the stale snapshot back would silently
  // clobber that update.
  persistIfNamed(profile, retried);
  return retried.accessToken;
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
