import { type UploadPolicyResponse, UploadPolicyResponseSchema } from '@crowi/api-contract';

import { ADHOC_ALIAS, type Profile, updateProfileFields } from './config';
import { CliError, authedFetch } from './http';
import { mediaTypeForFilename, mediaTypeFromTable } from './media-type';

/**
 * How long a cached (non-null) upload policy is considered fresh. Mirrors
 * `capability.ts`'s `CAPABILITY_TTL_MS` (kept as a separate constant rather
 * than a shared import — the two caches answer unrelated questions and
 * coupling them would make one's tuning silently affect the other). A
 * confirmed-404 (`null`) sentinel has no TTL: see `Profile.uploadPolicy`'s
 * doc comment for why that half never expires.
 */
const UPLOAD_POLICY_TTL_MS = 10 * 60 * 1000;

function isUploadPolicyFresh(profile: Profile): boolean {
  const fetchedAt = profile.uploadPolicyFetchedAt;
  if (typeof fetchedAt !== 'number') return false;
  return Date.now() - fetchedAt < UPLOAD_POLICY_TTL_MS;
}

/**
 * Fetch (or return the cached) `GET /attachments/upload-policy` for
 * `profile`. Returns `null` when the server predates the endpoint (a 404) —
 * the caller then falls back to `media-type.ts`'s local table, so an old
 * server sees no regression.
 *
 * The result is cached on the profile (persisted for a named profile, kept
 * in-memory only for the ad-hoc `--url`/`--token` profile) so `attach add`
 * does not round-trip on every invocation — see `Profile.uploadPolicy`'s
 * doc comment for the cache's shape (`undefined` unfetched / `null`
 * confirmed-absent / present = the policy) and its TTL.
 *
 * Any failure OTHER than a confirmed 404 (network error, 401/403/5xx, a
 * malformed body) degrades to the last-known cached value (or `null` when
 * there is none yet) WITHOUT writing anything — a transient failure is
 * worth retrying on the next invocation, and must not flap the CLI between
 * a real policy and the local table just because one refresh attempt
 * failed.
 */
export async function fetchUploadPolicy(profile: Profile): Promise<UploadPolicyResponse | null> {
  // A confirmed-absent policy never expires — an old server does not gain
  // the endpoint by CLI-side cache expiry.
  if (profile.uploadPolicy === null) {
    return null;
  }
  if (profile.uploadPolicy !== undefined && isUploadPolicyFresh(profile)) {
    return profile.uploadPolicy;
  }

  let body: unknown;
  try {
    body = await authedFetch<unknown>(profile, 'GET', '/attachments/upload-policy');
  } catch (err) {
    if (err instanceof CliError && err.status === 404) {
      if (profile.alias !== ADHOC_ALIAS) {
        updateProfileFields(profile.alias, { uploadPolicy: null });
      }
      return null;
    }
    return profile.uploadPolicy ?? null;
  }

  const parsed = UploadPolicyResponseSchema.safeParse(body);
  if (!parsed.success) {
    return profile.uploadPolicy ?? null;
  }

  if (profile.alias !== ADHOC_ALIAS) {
    updateProfileFields(profile.alias, { uploadPolicy: parsed.data, uploadPolicyFetchedAt: Date.now() });
  }
  return parsed.data;
}

/**
 * The media type to declare for `filename`. When `policy` is present, only
 * its `extensionHints` are consulted — a server publishing a policy is
 * authoritative, so an unmatched extension there declares
 * `application/octet-stream` (letting the server's own filename fallback
 * take over) rather than falling through to the local `media-type.ts` table.
 * When `policy` is `null` (old server / not yet resolved), the local table
 * is used instead.
 */
export function resolveDeclaredMediaType(filename: string, policy: UploadPolicyResponse | null): string {
  return policy ? mediaTypeFromTable(filename, policy.extensionHints) : mediaTypeForFilename(filename);
}
