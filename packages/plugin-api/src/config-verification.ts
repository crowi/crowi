/**
 * Contract for `CrowiPlugin.verifyConfig` — a non-blocking, post-save
 * connectivity/permission probe (feature-plugin-config-live-verification).
 * Deliberately its own module, separate from `context.ts`'s live
 * `PluginContext`: a verification hook runs AFTER the admin save has
 * already persisted (and after `reconfigure` has already rebuilt the live
 * driver), against the EXACT values that request saved — not whatever the
 * config cache holds by the time the hook actually runs. Handing a hook
 * `PluginContext` would let it call `ctx.setConfig()` / read a
 * concurrently-updated cache / touch models, none of which a read-only,
 * best-effort probe should be able to do.
 */

/**
 * Recursively read-only view of `T`. Used for both `config()` and
 * `dependencyConfig()` on {@link PluginConfigVerificationSnapshot} — a
 * verification hook must not be able to mutate the plan's materialized
 * values (they are shared across the plan and, for a dependency, may be
 * read by more than one hook).
 */
export type ReadonlyDeep<T> = T extends readonly (infer U)[]
  ? readonly ReadonlyDeep<U>[]
  : T extends object
    ? { readonly [K in keyof T]: ReadonlyDeep<T[K]> }
    : T;

/**
 * Immutable facade a `verifyConfig` hook reads its plugin's (and its
 * declared dependencies') config through. NOT `PluginContext`: this
 * snapshot is materialized once, before the save that triggered
 * verification, and never changes for the lifetime of the hook call — a
 * concurrent save of another plugin's config (or of this plugin's config,
 * from a second in-flight admin request) cannot change what an
 * already-running hook sees. See `PluginManager.createVerificationPlan()`.
 */
export interface PluginConfigVerificationSnapshot {
  /**
   * This plugin's own config, as it was — or will be, for the plugin whose
   * save triggered this verification — immediately after the save. Throws
   * if the plugin does not declare a `configSchema` (mirrors
   * `PluginContext.config()`).
   */
  config<T>(): ReadonlyDeep<T>;

  /**
   * A declared dependency's config. Same capability check as
   * `PluginContext.dependencyConfig()`: `dependencyName` must be listed in
   * this plugin's `requires`, AND the dependency must declare
   * `exposesConfigToDependents: true`. Throws otherwise.
   */
  dependencyConfig<T>(dependencyName: string): ReadonlyDeep<T>;
}

/**
 * Passed alongside the snapshot to every `verifyConfig` call.
 *
 * `timeoutMs` is a NOTICE, not a cancellation mechanism: the caller
 * (`PluginManager`) stops waiting on the hook's returned promise after
 * this many milliseconds and normalizes the result to
 * `{ status: 'failed', reason: 'unreachable' }`, but it never aborts the
 * hook itself — there is no `AbortSignal` here, and none is passed down to
 * any `StorageDriver` call a storage hook makes (the driver's public `put`
 * / `get` / `delete` contract takes no such option; see
 * `@crowi/plugin-api`'s `registries/storage.ts`). A hook whose underlying
 * I/O is still in flight when the caller gives up keeps running in the
 * background; hooks that touch external resources they created (e.g. a
 * storage probe object) should not rely on ever being told to stop, and
 * should clean up opportunistically rather than assume they'll get to run
 * to completion before anyone stops watching.
 */
export interface PluginConfigVerificationOptions {
  timeoutMs: number;
}

/** The closed set of reasons a verification probe can fail for. Anything a driver can't confidently place in one of these falls into `'unknown'` — a wrong specific reason would mislead an operator more than an honest "couldn't tell". */
export type VerificationFailureReason = 'unreachable' | 'auth-failed' | 'resource-missing' | 'write-denied' | 'unknown';

/**
 * What a `verifyConfig` hook resolves to. Deliberately a closed,
 * allow-listed shape — the caller projects whatever a hook returns onto
 * this union (an invalid shape normalizes to `{ status: 'failed', reason:
 * 'unknown' }`), so a hook can never smuggle raw SDK error text, a stack
 * trace, an endpoint, or credential material into the admin response or
 * logs by returning it as an extra field.
 */
export type PluginConfigVerificationResult = { status: 'ok' } | { status: 'failed'; reason: VerificationFailureReason };

/**
 * Key namespace every storage `verifyConfig` probe writes its round-trip
 * object under — deliberately disjoint from `attachment/*` (core's
 * uploaded-file namespace) so a probe object can never collide with,
 * shadow, or get mistaken for a real attachment. A storage hook builds its
 * probe key as `` `${CONFIG_VERIFICATION_KEY_PREFIX}<random>` ``; because
 * cleanup after a probe is best-effort (see the `timeoutMs` note on
 * {@link PluginConfigVerificationOptions}), an operator who finds a
 * leftover object can safely delete anything under this prefix.
 */
export const CONFIG_VERIFICATION_KEY_PREFIX = '__crowi_config_verification__/';
