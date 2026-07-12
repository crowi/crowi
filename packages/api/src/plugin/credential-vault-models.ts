/**
 * Core Mongoose model names that hold credential-like data — encrypted
 * config values, session/API tokens, OAuth client secrets and grants,
 * page-share tokens — and must never be grantable to a plugin via
 * `CrowiPlugin.modelAccess`. There is no legitimate plugin use case for
 * touching these collections directly (see
 * feature-plugin-capability-hardening spec): the only sanctioned path to
 * a plugin's own secrets is `ctx.config<T>()`, and to another plugin's
 * secrets (when that plugin opts in) `ctx.dependencyConfig<T>()`.
 *
 * Kept as a single module constant and imported by both
 * `plugin-manager.ts` (`assertValidModelAccess()`, the boot-time gate)
 * and `plugin-context.ts` (`ctx.model()`, the call-time gate) so the two
 * enforcement points can never drift apart.
 *
 * Names match the real export keys in `src/models/index.ts` exactly —
 * `OAuthAccessToken` does not exist there today and is intentionally
 * omitted (adding a non-existent name here would be harmless but the
 * list is kept in sync with reality rather than aspirational).
 */
export const CREDENTIAL_VAULT_MODEL_NAMES: ReadonlySet<string> = new Set([
  'Config',
  'PersonalAccessToken',
  'OAuthClient',
  'OAuthAuthorizationCode',
  'OAuthDeviceCode',
  'OAuthRefreshToken',
  'Share',
  'ShareAccess',
]);

/** `true` when `name` is a credential-vault model — see {@link CREDENTIAL_VAULT_MODEL_NAMES}. */
export function isCredentialVaultModel(name: string): boolean {
  return CREDENTIAL_VAULT_MODEL_NAMES.has(name);
}

/** Sorted, comma-joined list of denied model names — used in error messages. */
export function credentialVaultModelNamesList(): string {
  return [...CREDENTIAL_VAULT_MODEL_NAMES].sort().join(', ');
}
