import type Crowi from 'src/crowi';

import { createRegistry, type MigrationRegistry } from './registry';
import { MigrationRunner, noopProgress, type PreflightUnappliedPolicy } from './runner';
import type { MigrationLogger } from './types';

/**
 * RFC-0008 §4.2.1 — the boot-sequence migration step.
 *
 * Called from `crowi/index.ts` during init. Two responsibilities:
 *
 *   1. Apply every `layer:'boot'` migration that `isPending` flags, in
 *      version-range + `order` sequence, appending each result to the
 *      `migrationApplications` audit log.
 *   2. Probe every `layer:'preflight'` migration with `isPending` (cheap) and
 *      split the pending ones by `severity` (§4.2.7 amendment / §12.7):
 *        - `cosmetic` pending → always warn-and-continue (policy ignored);
 *        - `blocking` pending → refuse boot under `block` (the default), or
 *          warn-and-continue under `warn` — per `preflightUnappliedPolicy`.
 *
 * `block` is the safe default (§4.2.7) for `blocking` migrations: if
 * `user-unique-prepare` hasn't run before v2 boot, *every replica fail-fasts*
 * with a clear error before autoIndex would otherwise hit E11000 (§9) on
 * not-yet-deduped data. The operator then runs `crowi-admin migrate apply`
 * once and brings the cluster up. A pending `cosmetic` migration never blocks
 * boot: its `isPending` re-scans the live corpus, so new content could keep it
 * pending forever and a uniform block would deadlock the cluster (BUG 2).
 */

const POLICY_ENV_VAR = 'MIGRATION_PREFLIGHT_UNAPPLIED_POLICY';

/** Compile-time exhaustiveness guard (throws if a future `severity` reaches it). */
function assertNever(value: never): never {
  throw new Error(`[crowi:migration] unhandled migration severity: ${String(value)}`);
}

/** Error thrown when boot is refused under the `block` policy. */
export class PreflightBlockedError extends Error {
  readonly pendingIds: string[];
  constructor(pendingIds: string[]) {
    super(
      `Boot refused: ${pendingIds.length} preflight migration(s) are unapplied [${pendingIds.join(', ')}]. ` +
        'Run `crowi-admin migrate apply` against this database before starting the application ' +
        `(set ${POLICY_ENV_VAR}=warn to override at your own risk).`,
    );
    this.name = 'PreflightBlockedError';
    this.pendingIds = pendingIds;
  }
}

/**
 * Resolve the preflight-unapplied policy. Env var override (§12.7) wins over
 * the `migration.preflightUnappliedPolicy` config namespace, which in turn
 * defaults to `block`.
 */
export function resolvePreflightPolicy(crowi: Crowi): PreflightUnappliedPolicy {
  const fromEnv = crowi.env[POLICY_ENV_VAR];
  if (fromEnv === 'warn' || fromEnv === 'block') return fromEnv;

  const cfg = crowi.getConfig() as { migration?: { preflightUnappliedPolicy?: unknown } } | undefined;
  const fromConfig = cfg?.migration?.preflightUnappliedPolicy;
  if (fromConfig === 'warn' || fromConfig === 'block') return fromConfig;

  return 'block';
}

export interface RunBootMigrationsOptions {
  /** Override the registry (tests inject a registry of fixture migrations). */
  registry?: MigrationRegistry;
  /** Override the policy resolution (tests). */
  policy?: PreflightUnappliedPolicy;
  /** Live force-reload broadcast for boot-layer migrations (api process). */
  broadcastForceReload?: (pageIds: string[]) => Promise<void>;
  /** Logger override (tests / quiet boot). */
  logger?: MigrationLogger;
}

export interface RunBootMigrationsResult {
  appliedBootIds: string[];
  /** Pending `severity:'blocking'` preflight migrations (gate boot under `block`). */
  pendingBlockingIds: string[];
  /** Pending `severity:'cosmetic'` preflight migrations (never gate boot). */
  pendingCosmeticIds: string[];
  policy: PreflightUnappliedPolicy;
}

export async function runBootMigrations(crowi: Crowi, options: RunBootMigrationsOptions = {}): Promise<RunBootMigrationsResult> {
  const registry = options.registry ?? createRegistry();
  const policy = options.policy ?? resolvePreflightPolicy(crowi);

  const runner = new MigrationRunner(crowi, {
    appliedBy: 'boot-auto',
    progress: noopProgress,
    logger: options.logger,
    // Boot layer (api process) can broadcast a live force-reload; preflight
    // probing below never mutates, so the handle is only meaningful here.
    broadcastForceReload: options.broadcastForceReload,
  });

  // ── 1. Apply pending boot migrations in order ──
  const appliedBootIds: string[] = [];
  for (const def of registry.byLayer('boot')) {
    const outcome = await runner.apply(def);
    if (outcome.result === 'applied' || outcome.result === 're-applied') {
      appliedBootIds.push(def.id);
    }
  }

  // ── 2. Probe preflight migrations (cheap isPending), split by severity ──
  //
  // Every preflight migration is still probed (RFC-0008 §6.1/§6.2: inspection
  // = source of truth). What changed is only the *consequence* of a pending
  // verdict, decided per-migration by `severity`:
  //   - `cosmetic` pending → always warn-and-continue (global knob ignored);
  //   - `blocking` pending → refuse boot under `block`, warn-and-continue under
  //     `warn` (the existing emergency override).
  const pendingBlockingIds: string[] = [];
  const pendingCosmeticIds: string[] = [];
  for (const def of registry.byLayer('preflight')) {
    if (!(await runner.isPending(def))) continue;
    switch (def.severity) {
      case 'blocking':
        pendingBlockingIds.push(def.id);
        break;
      case 'cosmetic':
        pendingCosmeticIds.push(def.id);
        break;
      default:
        // Exhaustive: a new severity must consciously pick a boot-gate side
        // rather than silently fall through to non-blocking (fail-open).
        assertNever(def.severity);
    }
  }

  // Cosmetic pending always warns and continues, regardless of policy. Emitted
  // before the blocking decision so it is observable even on the block-throw
  // path (the result object is not returned then). A distinct message per
  // severity keeps operator grep / alert rules simple.
  if (pendingCosmeticIds.length > 0) {
    console.warn(
      `[crowi:migration] WARNING: ${pendingCosmeticIds.length} cosmetic preflight migration(s) unapplied ` +
        `[${pendingCosmeticIds.join(', ')}] — body display only; boot continues.`,
    );
  }

  if (pendingBlockingIds.length > 0) {
    if (policy === 'block') {
      // Whole-cluster fail-fast for blocking migrations only (§4.2.7). The
      // result object (and its severity split) is not returned on this path.
      throw new PreflightBlockedError(pendingBlockingIds);
    }
    // warn: operator explicitly accepts the data-integrity risk.
    console.warn(
      `[crowi:migration] WARNING: ${pendingBlockingIds.length} preflight migration(s) unapplied ` +
        `[${pendingBlockingIds.join(', ')}] — data-integrity risk; autoIndex may fail with E11000.`,
    );
  }

  return { appliedBootIds, pendingBlockingIds, pendingCosmeticIds, policy };
}
