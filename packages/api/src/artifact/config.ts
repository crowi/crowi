/**
 * feature-html-artifact-delivery-policy §K 表 / §M 表 — the single place
 * that defines the `artifact:policy` config key, its field names, its
 * installer seed, and every fixed operator/admin-facing message this leaf
 * emits. `installer` seed, the policy resolver, the admin handler, and
 * tests all import these constants rather than writing the literal key
 * name — `ConfigService.get(ns, key)` hides a typo'd key behind its
 * fallback (`packages/api/src/service/config.ts:102-112`), so a
 * `crowi:artifactMaxBytes`-shaped literal anywhere in this leaf would fail
 * silently instead of erroring.
 *
 * Byte limits and the reserved digest-marker names are NOT redefined here
 * — they live in `./constants` (a dependency-free module also read by the
 * core ingest leaf) and are imported, never duplicated.
 *
 * This module imports nothing from `./ingest`, DB, HTTP, or `Crowi` — see
 * `./constants`'s own doc comment for why the import graph matters
 * (`models/config.ts` → `./config` → `./constants` must terminate before
 * ever reaching parse5/PostCSS).
 */

import { DEFAULT_ARTIFACT_MAX_BYTES } from './constants';

// ---------------------------------------------------------------------------
// §K 表 — config key / field names / installer seed
// ---------------------------------------------------------------------------

export const ARTIFACT_CONFIG_NAMESPACE = 'crowi';
export const ARTIFACT_POLICY_KEY = 'artifact:policy';

export const ARTIFACT_POLICY_FIELDS = ['sameOriginEnabled', 'allowWebFonts', 'maxBytes'] as const;
export type ArtifactPolicyField = (typeof ARTIFACT_POLICY_FIELDS)[number];

/**
 * Seed object `getArrayForInstalling()` spreads into the `crowi` namespace on
 * a fresh install (`models/config.ts`). An existing install with no
 * `artifact:policy` row resolves the identical defaults via `policy.ts`'s
 * §C 表 missing-key fallback, so this seed only exists to make the row
 * present (and therefore visible in `Config.find({ ns: 'crowi' })`) from the
 * first boot rather than lazily materializing on first admin save.
 */
export const ARTIFACT_CONFIG_SEED = {
  [ARTIFACT_POLICY_KEY]: {
    sameOriginEnabled: false,
    allowWebFonts: false,
    maxBytes: DEFAULT_ARTIFACT_MAX_BYTES,
  },
} as const;

// ---------------------------------------------------------------------------
// §M 表 — fixed operator / admin messages (English, no embedded settings
// values / secrets / user content — origins and key names are fine)
// ---------------------------------------------------------------------------

export const ARTIFACT_BOOT_NOTE_DISABLED =
  '[crowi] artifact delivery is disabled: set CROWI_ARTIFACT_ORIGIN (recommended) or enable same-origin delivery in ' +
  'Admin > Artifact. Artifact writes are rejected until one of them is configured.';

export const ARTIFACT_BOOT_NOTE_SAME_ORIGIN_NEEDS_CLIENT_URL =
  '[crowi] artifact delivery is disabled: same-origin delivery is enabled in settings but CLIENT_URL is not set. Set ' +
  'CLIENT_URL (or CROWI_ARTIFACT_ORIGIN) to activate artifact delivery.';

export const ARTIFACT_BOOT_NOTE_SEPARATE_ORIGIN_SHADOWS_SAME_ORIGIN =
  '[crowi] artifact delivery: separate-origin mode is active (CROWI_ARTIFACT_ORIGIN); the same-origin setting is stored but inactive.';

export const ARTIFACT_BOOT_NOTE_SEPARATE_ORIGIN_ACTIVE = '[crowi] artifact delivery: separate-origin mode is active.';

export const ARTIFACT_BOOT_NOTE_SAME_ORIGIN_ACTIVE = '[crowi] artifact delivery: same-origin mode is active.';

/**
 * §C-4 — invalid-stored-value warning, one per `field` per process. `field`
 * is `'policy'` when the whole `artifact:policy` value is malformed (not an
 * object), otherwise the specific field that failed its own check.
 */
export function artifactConfigInvalidValueWarning(field: ArtifactPolicyField | 'policy'): string {
  if (field === 'policy') {
    return '[crowi] artifact config: artifact:policy holds an invalid stored value; using the defaults.';
  }
  return `[crowi] artifact config: artifact:policy.${field} holds an invalid stored value; using the default.`;
}

export const ARTIFACT_ADMIN_SAME_ORIGIN_REQUIRES_CLIENT_URL_MESSAGE =
  'Same-origin artifact delivery requires CLIENT_URL to be set on the api. Set CLIENT_URL (or use CROWI_ARTIFACT_ORIGIN) and try again.';
