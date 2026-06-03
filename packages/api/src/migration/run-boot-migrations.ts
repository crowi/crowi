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
 *   2. Probe every `layer:'preflight'` migration with `isPending` (cheap)
 *      and, when any is unapplied, either refuse boot (`block`, default) or
 *      log loudly and continue (`warn`) — per `preflightUnappliedPolicy`.
 *
 * `block` is the safe default (§4.2.7): if a preflight migration hasn't run
 * before v2 boot, *every replica fail-fasts* with a clear error before
 * autoIndex would otherwise hit E11000 (§9) on not-yet-deduped data. The
 * operator then runs `crowi-admin migrate apply` once and brings the cluster
 * up.
 *
 * Phase 1 ships with an empty registry, so this is a fast no-op; the wiring
 * is what matters. Phase 2 adds `page-status-default` as the first boot
 * migration.
 */

const POLICY_ENV_VAR = 'MIGRATION_PREFLIGHT_UNAPPLIED_POLICY';

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
  pendingPreflightIds: string[];
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

  // ── 2. Probe preflight migrations (cheap isPending) ──
  const pendingPreflightIds: string[] = [];
  for (const def of registry.byLayer('preflight')) {
    if (await runner.isPending(def)) {
      pendingPreflightIds.push(def.id);
    }
  }

  if (pendingPreflightIds.length > 0) {
    if (policy === 'block') {
      // Whole-cluster fail-fast (§4.2.7).
      throw new PreflightBlockedError(pendingPreflightIds);
    }
    // warn: operator explicitly accepts the risk.
    console.warn(
      `[crowi:migration] WARNING: ${pendingPreflightIds.length} preflight migration(s) unapplied [${pendingPreflightIds.join(', ')}] ` +
        `but ${POLICY_ENV_VAR}=warn — continuing boot. Data may not be in the target shape; autoIndex may fail with E11000.`,
    );
  }

  return { appliedBootIds, pendingPreflightIds, policy };
}
