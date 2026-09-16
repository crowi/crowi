/**
 * feature-html-artifact-delivery-policy §R 表 / §C 表 / §S 表 — resolving
 * whether HTML artifact delivery is active, in which mode, and the settings
 * write path / delivery route consume from a single, request-local snapshot.
 *
 * `computeArtifactPolicyState` is a pure function of `{ env, config }` (no DB
 * / Redis / request access); `resolveArtifactPolicyState` /
 * `resolveArtifactPolicySnapshot` read those two inputs off a booted `Crowi`
 * and additionally emit the §C-4 invalid-stored-value warnings (process +
 * field, once each).
 */

import type Crowi from 'src/crowi';
import { getCrowiConfigNamespace } from 'src/util/admin-config';
import type { ArtifactDeliveryEnv } from 'src/util/env-schema';
import {
  ARTIFACT_BOOT_NOTE_DISABLED,
  ARTIFACT_BOOT_NOTE_SAME_ORIGIN_ACTIVE,
  ARTIFACT_BOOT_NOTE_SAME_ORIGIN_NEEDS_CLIENT_URL,
  ARTIFACT_BOOT_NOTE_SEPARATE_ORIGIN_ACTIVE,
  ARTIFACT_BOOT_NOTE_SEPARATE_ORIGIN_SHADOWS_SAME_ORIGIN,
  ARTIFACT_POLICY_KEY,
  type ArtifactPolicyField,
  artifactConfigInvalidValueWarning,
} from './config';
import { DEFAULT_ARTIFACT_MAX_BYTES, ARTIFACT_HARD_MAX_BYTES, ARTIFACT_MIN_MAX_BYTES } from './constants';

// ---------------------------------------------------------------------------
// Public types (§契約)
// ---------------------------------------------------------------------------

export type ArtifactDeliveryMode = 'separate-origin' | 'same-origin' | 'disabled';

export type ArtifactPolicySnapshot = Readonly<{
  deliveryMode: ArtifactDeliveryMode;
  artifactOrigin: string | null;
  crowiOrigin: string | null;
  writeEnabled: boolean;
  allowWebFonts: boolean;
  maxBytes: number;
}>;

export type ArtifactSameOriginInactiveReason = 'separate-origin-active' | 'client-url-unset';

export type ArtifactPolicySettings = Readonly<{ sameOriginEnabled: boolean; allowWebFonts: boolean; maxBytes: number }>;

export interface ArtifactPolicyInput {
  readonly env: ArtifactDeliveryEnv;
  /** The `crowi` config namespace (`crowi.getConfig().crowi`) — see `util/admin-config.ts#getCrowiConfigNamespace`. */
  readonly config: Readonly<Record<string, unknown>>;
}

export type ArtifactPolicyState = Readonly<{
  snapshot: ArtifactPolicySnapshot;
  settings: ArtifactPolicySettings;
  sameOriginInactiveReason: ArtifactSameOriginInactiveReason | null;
  invalidFields: readonly (ArtifactPolicyField | 'policy')[];
}>;

// ---------------------------------------------------------------------------
// §C 表 — reading the stored `artifact:policy` value
// ---------------------------------------------------------------------------

interface ReadArtifactPolicySettingsResult {
  settings: ArtifactPolicySettings;
  invalidFields: readonly (ArtifactPolicyField | 'policy')[];
}

/** §C-1 / §C-2 — literal `true` only; anything else (string `'true'`, `1`, missing) is `false`, matching `util/admin-config.ts#coerceBoolean`'s strictness. */
function readBooleanField(
  record: Readonly<Record<string, unknown>>,
  field: 'sameOriginEnabled' | 'allowWebFonts',
  invalidFields: (ArtifactPolicyField | 'policy')[],
): boolean {
  const value = record[field];
  if (value === undefined) return false;
  if (typeof value === 'boolean') return value;
  invalidFields.push(field);
  return false;
}

/** §C-3 — an integer in `[ARTIFACT_MIN_MAX_BYTES, ARTIFACT_HARD_MAX_BYTES]`; deliberately not `coerceNumber` (a numeric string like `'2097152'` must fall back, not be accepted). */
function readMaxBytesField(record: Readonly<Record<string, unknown>>, invalidFields: (ArtifactPolicyField | 'policy')[]): number {
  const value = record.maxBytes;
  if (value === undefined) return DEFAULT_ARTIFACT_MAX_BYTES;
  if (typeof value === 'number' && Number.isInteger(value) && value >= ARTIFACT_MIN_MAX_BYTES && value <= ARTIFACT_HARD_MAX_BYTES) {
    return value;
  }
  invalidFields.push('maxBytes');
  return DEFAULT_ARTIFACT_MAX_BYTES;
}

/**
 * §C-0 — reads the stored `artifact:policy` key. A missing key resolves to
 * all-default with no warning (a fresh row-less install, or a race with the
 * installer seed); a present-but-non-object value resolves to all-default
 * with a single `'policy'` invalid-field entry (its 3 fields are never read
 * individually in that case, so they never ALSO report their own
 * invalid-field entries — §C-4's "once per field" count stays at 4 possible
 * entries total, not "policy" plus 3 more).
 */
function readArtifactPolicySettings(config: Readonly<Record<string, unknown>>): ReadArtifactPolicySettingsResult {
  const raw = config[ARTIFACT_POLICY_KEY];
  const invalidFields: (ArtifactPolicyField | 'policy')[] = [];

  const isPlainObject = typeof raw === 'object' && raw !== null && !Array.isArray(raw);
  if (raw !== undefined && !isPlainObject) {
    invalidFields.push('policy');
  }
  const record: Readonly<Record<string, unknown>> = isPlainObject ? (raw as Record<string, unknown>) : {};

  const sameOriginEnabled = readBooleanField(record, 'sameOriginEnabled', invalidFields);
  const allowWebFonts = readBooleanField(record, 'allowWebFonts', invalidFields);
  const maxBytes = readMaxBytesField(record, invalidFields);

  return { settings: { sameOriginEnabled, allowWebFonts, maxBytes }, invalidFields };
}

// ---------------------------------------------------------------------------
// §R 表 — delivery mode resolution
// ---------------------------------------------------------------------------

interface ResolvedDeliveryMode {
  deliveryMode: ArtifactDeliveryMode;
  artifactOrigin: string | null;
  crowiOrigin: string | null;
  writeEnabled: boolean;
  sameOriginInactiveReason: ArtifactSameOriginInactiveReason | null;
}

/**
 * §R 表, evaluated top-to-bottom. The signing key (`SECRET_TOKEN`) is not
 * checked here: an unset or placeholder value aborts boot before this runs.
 */
function resolveDeliveryMode(env: ArtifactDeliveryEnv, settings: ArtifactPolicySettings): ResolvedDeliveryMode {
  if (env.artifactOrigin !== null) {
    return {
      deliveryMode: 'separate-origin',
      artifactOrigin: env.artifactOrigin,
      crowiOrigin: env.crowiOrigin,
      writeEnabled: true,
      sameOriginInactiveReason: settings.sameOriginEnabled ? 'separate-origin-active' : null,
    };
  }
  if (settings.sameOriginEnabled && env.crowiOrigin !== null) {
    return { deliveryMode: 'same-origin', artifactOrigin: env.crowiOrigin, crowiOrigin: env.crowiOrigin, writeEnabled: true, sameOriginInactiveReason: null };
  }
  if (settings.sameOriginEnabled && env.crowiOrigin === null) {
    return { deliveryMode: 'disabled', artifactOrigin: null, crowiOrigin: null, writeEnabled: false, sameOriginInactiveReason: 'client-url-unset' };
  }
  return { deliveryMode: 'disabled', artifactOrigin: null, crowiOrigin: env.crowiOrigin, writeEnabled: false, sameOriginInactiveReason: null };
}

/**
 * Pure state resolver — the entire §R 表 / §C 表 in one call. Touches
 * neither the DB, Redis, nor a request; every input is `{ env, config }`.
 */
export function computeArtifactPolicyState(input: ArtifactPolicyInput): ArtifactPolicyState {
  const { settings, invalidFields } = readArtifactPolicySettings(input.config);
  const resolved = resolveDeliveryMode(input.env, settings);

  const snapshot: ArtifactPolicySnapshot = Object.freeze({
    deliveryMode: resolved.deliveryMode,
    artifactOrigin: resolved.artifactOrigin,
    crowiOrigin: resolved.crowiOrigin,
    writeEnabled: resolved.writeEnabled,
    allowWebFonts: settings.allowWebFonts,
    maxBytes: settings.maxBytes,
  });

  return Object.freeze({
    snapshot,
    settings: Object.freeze({ ...settings }),
    sameOriginInactiveReason: resolved.sameOriginInactiveReason,
    invalidFields: Object.freeze([...invalidFields]),
  });
}

// ---------------------------------------------------------------------------
// Crowi-bound resolvers
// ---------------------------------------------------------------------------

/** §C-4 — process-local, field-scoped warn-once set. `resetArtifactConfigWarningsForTests()` is the only way to clear it (tests only). */
const warnedInvalidFields = new Set<ArtifactPolicyField | 'policy'>();

/** Test-only escape hatch so a suite exercising multiple invalid-value scenarios can observe each one's first warning. */
export function resetArtifactConfigWarningsForTests(): void {
  warnedInvalidFields.clear();
}

/**
 * Reads `crowi.getArtifactDeliveryEnv()` (process-fixed) and the `crowi`
 * config namespace (in-memory, request-time), computes the full state, and
 * emits any new §C-4 invalid-value warnings via `crowi.bootNote(...)`.
 * Callable only after the `config` boot step has run (`crowi.getConfig()`
 * is undefined before then).
 */
export function resolveArtifactPolicyState(crowi: Crowi): ArtifactPolicyState {
  const env = crowi.getArtifactDeliveryEnv();
  const config = getCrowiConfigNamespace(crowi);
  const state = computeArtifactPolicyState({ env, config });

  for (const field of state.invalidFields) {
    if (warnedInvalidFields.has(field)) continue;
    warnedInvalidFields.add(field);
    crowi.bootNote(() => console.warn(artifactConfigInvalidValueWarning(field)));
  }

  return state;
}

/**
 * The request-local snapshot §契約 hand-off — `feature-html-artifact-write-path`
 * calls this once per request and threads the returned object through every
 * gate / ingest-option read for that request without re-evaluating config.
 */
export function resolveArtifactPolicySnapshot(crowi: Crowi): ArtifactPolicySnapshot {
  return resolveArtifactPolicyState(crowi).snapshot;
}

/**
 * `.writeEnabled` only, no independent fallback logic. The 2-argument
 * overload reads ONLY the passed snapshot — it never calls
 * `crowi.getArtifactDeliveryEnv()` / `crowi.getConfig()` again, so a caller
 * that already resolved a snapshot this request never double-evaluates
 * config (the write-path leaf's §契約: resolve once, gate + ingest options
 * off the same object).
 */
export function isArtifactWriteEnabled(crowi: Crowi): boolean;
export function isArtifactWriteEnabled(crowi: Crowi, snapshot: ArtifactPolicySnapshot): boolean;
export function isArtifactWriteEnabled(crowi: Crowi, snapshot?: ArtifactPolicySnapshot): boolean {
  if (snapshot !== undefined) return snapshot.writeEnabled;
  return resolveArtifactPolicySnapshot(crowi).writeEnabled;
}

// ---------------------------------------------------------------------------
// §S 表 — boot-time status note
// ---------------------------------------------------------------------------

/**
 * Emits exactly one `crowi.bootNote(...)` line describing the resolved
 * delivery state (§S-5). `deliveryMode === 'disabled'` alone doesn't
 * distinguish R-3 (same-origin needs CLIENT_URL) from R-4 (nothing
 * configured) — `sameOriginInactiveReason` already carries R-3, so anything
 * else falls through to R-4.
 */
export function reportArtifactPolicyAtBoot(crowi: Crowi): void {
  const { snapshot, sameOriginInactiveReason } = resolveArtifactPolicyState(crowi);

  if (snapshot.deliveryMode === 'separate-origin') {
    if (sameOriginInactiveReason === 'separate-origin-active') {
      crowi.bootNote(() => console.log(ARTIFACT_BOOT_NOTE_SEPARATE_ORIGIN_SHADOWS_SAME_ORIGIN));
    } else {
      crowi.bootNote(() => console.log(ARTIFACT_BOOT_NOTE_SEPARATE_ORIGIN_ACTIVE));
    }
    return;
  }

  if (snapshot.deliveryMode === 'same-origin') {
    crowi.bootNote(() => console.log(ARTIFACT_BOOT_NOTE_SAME_ORIGIN_ACTIVE));
    return;
  }

  if (sameOriginInactiveReason === 'client-url-unset') {
    crowi.bootNote(() => console.warn(ARTIFACT_BOOT_NOTE_SAME_ORIGIN_NEEDS_CLIENT_URL));
    return;
  }

  crowi.bootNote(() => console.warn(ARTIFACT_BOOT_NOTE_DISABLED));
}
