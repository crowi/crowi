/**
 * Registry of Config (ns, key) pairs whose values should be encrypted at rest.
 *
 * Anything stored in the Config collection that resembles a secret token,
 * password, or third-party API credential goes here. Equality lookups against
 * these values are not supported (encryption is non-deterministic), but the
 * Config flow only ever loads them by (ns, key) so that constraint is fine.
 *
 * Out of scope:
 * - User.password (already bcrypt-hashed, one-way)
 * - PersonalAccessToken.tokenHash (already SHA-256-hashed, one-way; the
 *   legacy User.apiToken this replaced was removed in RFC-0010 Phase 2)
 * - Share.secretKeyword (looked up by equality, needs deterministic scheme)
 */
const SENSITIVE_CONFIG_KEYS: ReadonlySet<string> = new Set([
  // Slack notification credentials.
  'notification:slack:clientSecret',
  'notification:slack:token',
  // Storage / mail / other third-party credentials live in their plugin's
  // config namespace (`crowi:plugin:<name>:<field>`) and are registered at
  // boot from each plugin's `@sensitive`-marked schema fields — see
  // `RUNTIME_SENSITIVE_KEYS` below. They are not listed statically here.
]);

/**
 * Runtime-extensible sensitive set. Plugins contribute their
 * `@sensitive`-marked configSchema fields here at boot via
 * `registerSensitiveConfigKeys`, so the persisted plugin config
 * rows (`crowi:plugin:<name>:<field>`) inherit the same encrypt /
 * decrypt path as the legacy keys above. Stored as the same
 * `<ns>:<key>` compound shape as the static set.
 */
const RUNTIME_SENSITIVE_KEYS = new Set<string>();

export function isSensitiveConfig(ns: string, key: string): boolean {
  const compound = `${ns}:${key}`;
  return SENSITIVE_CONFIG_KEYS.has(compound) || RUNTIME_SENSITIVE_KEYS.has(compound);
}

/**
 * Add to the runtime sensitive set. The PluginManager calls this once
 * per loaded plugin during boot, after walking `configSchema` for
 * `@sensitive` fields. Idempotent — re-registering the same key on a
 * subsequent boot is a no-op.
 */
export function registerSensitiveConfigKeys(compoundKeys: Iterable<string>): void {
  for (const compound of compoundKeys) RUNTIME_SENSITIVE_KEYS.add(compound);
}

/**
 * Drop all runtime-registered keys. Used by long-lived test processes
 * that boot the Crowi app multiple times across describe blocks.
 */
export function resetRuntimeSensitiveConfigKeys(): void {
  RUNTIME_SENSITIVE_KEYS.clear();
}

/**
 * Returns the full set of sensitive (ns, key) pairs for admin scan / re-encrypt
 * tooling. Internal copy; do not mutate.
 */
export function listSensitiveConfigKeys(): Array<{ ns: string; key: string }> {
  const all = new Set<string>([...SENSITIVE_CONFIG_KEYS, ...RUNTIME_SENSITIVE_KEYS]);
  return Array.from(all).map((compound) => {
    const idx = compound.indexOf(':');
    return { ns: compound.slice(0, idx), key: compound.slice(idx + 1) };
  });
}
