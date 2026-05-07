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
 * - User.apiToken (looked up by equality, needs deterministic / hashed scheme)
 * - Share.secretKeyword (same reason as apiToken)
 */
const SENSITIVE_CONFIG_KEYS: ReadonlySet<string> = new Set([
  'crowi:google:clientSecret',
  'crowi:github:clientSecret',
  'crowi:upload:aws:accessKeyId',
  'crowi:upload:aws:secretAccessKey',
  'crowi:mail:aws:accessKeyId',
  'crowi:mail:aws:secretAccessKey',
  'crowi:mail:smtpPassword',
  'notification:slack:clientSecret',
  'notification:slack:token',
]);

export function isSensitiveConfig(ns: string, key: string): boolean {
  return SENSITIVE_CONFIG_KEYS.has(`${ns}:${key}`);
}

/**
 * Returns the full set of sensitive (ns, key) pairs for admin scan / re-encrypt
 * tooling. Internal copy; do not mutate.
 */
export function listSensitiveConfigKeys(): Array<{ ns: string; key: string }> {
  return Array.from(SENSITIVE_CONFIG_KEYS).map((compound) => {
    const idx = compound.indexOf(':');
    return { ns: compound.slice(0, idx), key: compound.slice(idx + 1) };
  });
}
