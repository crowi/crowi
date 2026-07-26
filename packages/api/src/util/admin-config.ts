import type Crowi from 'src/crowi';

/**
 * Helpers for reading values out of the in-memory Crowi config cache and
 * coercing them into the typed shape expected by ts-rest admin handlers.
 *
 * The cache is populated by `ConfigModel.loadAllConfig`, which JSON-parses
 * stored values, so for well-behaved keys we get the right runtime type
 * directly. These helpers exist to defend against:
 *   - missing keys on a fresh / older install
 *   - hand-edited rows in Mongo that don't match the expected type
 *   - the legacy form-encoded path that wrote string values for non-string
 *     keys (e.g. checkbox 'on' for booleans)
 *
 * Without them, every admin GET handler would either 500 on bad data or
 * inline its own coercion logic. Lifting them here keeps the handlers small
 * and the fallback semantics consistent.
 */

/**
 * Read the canonical `crowi` namespace from the in-memory config cache.
 * Returns an empty object when the cache hasn't been populated yet (e.g.
 * during the very first GET on a fresh install).
 */
export const getCrowiConfigNamespace = (crowi: Crowi): Record<string, unknown> => {
  const cfg = crowi.getConfig();
  if (cfg && typeof cfg === 'object') {
    const ns = (cfg as { crowi?: Record<string, unknown> }).crowi;
    if (ns) return ns;
  }
  return {};
};

/**
 * Coerce an unknown config value to a boolean. Only an actual boolean
 * counts; anything else (undefined, null, the string 'true', 1, etc.)
 * collapses to `fallback` (default `false`). Strict by design — we don't
 * want a hand-edited string 'true' to silently flip a security toggle.
 */
export const coerceBoolean = (value: unknown, fallback = false): boolean => {
  if (typeof value === 'boolean') return value;
  return fallback;
};

/**
 * Coerce an unknown config value to a string. Missing → fallback,
 * already-a-string → kept, anything else → stringified via `String(value)`.
 *
 * The stringify branch is defensive — it preserves the original value's
 * information for non-string-but-non-null entries instead of dropping to
 * the fallback. Most production callers never hit it.
 */
export const coerceString = (value: unknown, fallback = ''): string => {
  if (value === null || value === undefined) return fallback;
  if (typeof value === 'string') return value;
  return String(value);
};

/**
 * Coerce an unknown config value to a number. Numeric → kept,
 * numeric string → parsed, anything else → fallback (default 0).
 *
 * Used for fields like `mail:smtpPort` where the legacy form encoded the
 * value as a string but the contract surfaces a number.
 */
export const coerceNumber = (value: unknown, fallback = 0): number => {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value !== '') {
    const n = Number(value);
    return Number.isFinite(n) ? n : fallback;
  }
  return fallback;
};

/**
 * Read the `security:linkCardEnabled` toggle (feature-renderer-plugin-boundary
 * Phase 2), default `true`. The single source of truth for both the value
 * and its fallback policy — call this instead of re-reading the raw config
 * key, so a future change to either can't silently drift between call sites.
 */
export const isLinkCardEnabled = (crowi: Crowi): boolean => coerceBoolean(getCrowiConfigNamespace(crowi)['security:linkCardEnabled'], true);

/**
 * Coerce an unknown config value to a string[]. Array → filter to strings,
 * single newline-separated string (legacy textarea storage) → split on '\n',
 * anything else → [].
 *
 * Used for `security:registrationWhiteList` where the legacy form filter
 * `stringToArrayFilter` always produced an array, but data migrated from
 * pre-filter installs may still hold a raw textarea string.
 */
export const coerceStringArray = (value: unknown): string[] => {
  if (Array.isArray(value)) {
    return value.filter((entry): entry is string => typeof entry === 'string');
  }
  if (typeof value === 'string' && value.length > 0) {
    return value.split('\n');
  }
  return [];
};
