import path from 'node:path';
import dotenv from 'dotenv';
import type { Command } from 'commander';

/**
 * RFC-0008 §8 — the `crowi-admin migrate plan|apply|status|list` namespace.
 *
 * One-shot, forward-only migrations. `plan` / `apply` default to the
 * `preflight` layer (§4.2.2); `--all-layers` extends to boot migrations too
 * (debugging / investigation). The boot layer is normally applied by the api
 * boot sequence, not from here.
 *
 * Like the other admin commands, this loads the api's compiled `dist/`
 * lazily (see `storage-copy.ts` for the `require.resolve` rationale — we
 * avoid importing `@crowi/api` directly so its `app.ts` auto-boot doesn't
 * fire) and talks to MongoDB directly.
 */

/** Minimal structural mirror of the api-side `MigrationCliApi` façade. */
interface MigrationSummary {
  id: string;
  fromVersion: string;
  toVersion: string;
  layer: 'boot' | 'preflight';
  severity: 'blocking' | 'cosmetic';
  description: string;
}
interface DetectReport {
  summary: string;
  counts?: Record<string, number>;
}
interface MigrationPlanEntry extends MigrationSummary {
  pending: boolean;
  detail: DetectReport | null;
}
interface MigrationStatusEntry {
  migrationId: string;
  result: string;
  appliedAt: Date;
  durationMs?: number;
  appliedBy?: string;
}
interface MigrationStatus {
  latestTarget: string | null;
  recent: MigrationStatusEntry[];
  pendingPreflight: number;
  pendingBoot: number;
}
interface ApplyOutcome {
  id: string;
  result: string;
  durationMs: number;
}
interface MigrationCliApi {
  list(): MigrationSummary[];
  latestTarget(): string | null;
  plan(options: { allLayers?: boolean }): Promise<MigrationPlanEntry[]>;
  apply(options: { allLayers?: boolean; dryRun?: boolean; id?: string; continueOnError?: boolean }): Promise<ApplyOutcome[]>;
  status(recentLimit?: number): Promise<MigrationStatus>;
}

interface ApiCrowi {
  initForCli(): Promise<void>;
  teardownForCli(): Promise<void>;
}
interface ApiCrowiCtor {
  new (rootDir: string, env: NodeJS.ProcessEnv): ApiCrowi;
}
type CreateMigrationCliApi = (crowi: ApiCrowi) => MigrationCliApi;

function loadApi(): { Crowi: ApiCrowiCtor; createMigrationCliApi: CreateMigrationCliApi } | null {
  let apiPkgPath: string;
  try {
    apiPkgPath = require.resolve('@crowi/api/package.json', { paths: [process.cwd(), __dirname] });
  } catch {
    return null;
  }
  const apiRoot = path.dirname(apiPkgPath);
  const distDir = path.join(apiRoot, 'dist');

  const crowiModule = require(path.join(distDir, 'crowi')) as { default: ApiCrowiCtor };
  const cliApiModule = require(path.join(distDir, 'migration', 'cli-api')) as { createMigrationCliApi: CreateMigrationCliApi };

  return { Crowi: crowiModule.default, createMigrationCliApi: cliApiModule.createMigrationCliApi };
}

/**
 * Boot a lightweight Crowi, hand it to `fn`, then tear it down. Centralizes
 * the .env load / loadApi guard / init / teardown ceremony shared by every
 * `migrate` subcommand. Exits the process with a non-zero code on failure.
 */
async function withMigrationApi(fn: (api: MigrationCliApi) => Promise<void>): Promise<void> {
  dotenv.config();

  const loaded = loadApi();
  if (!loaded) {
    console.error('crowi-admin: could not locate @crowi/api. Run from a directory that has @crowi/api installed (e.g. the runner package).');
    process.exit(1);
  }

  const crowi = new loaded.Crowi(process.cwd(), process.env);
  try {
    await crowi.initForCli();
  } catch (err) {
    console.error('crowi-admin: failed to initialise Crowi:', (err as Error).message);
    await crowi.teardownForCli().catch(() => undefined);
    process.exit(1);
  }

  let exitCode = 0;
  try {
    await fn(loaded.createMigrationCliApi(crowi));
  } catch (err) {
    console.error('crowi-admin: migrate command failed.');
    console.error(err instanceof Error ? (err.stack ?? err.message) : String(err));
    exitCode = 1;
  } finally {
    await crowi.teardownForCli().catch(() => undefined);
  }
  process.exit(exitCode);
}

function formatRange(entry: { fromVersion: string; toVersion: string }): string {
  return `${entry.fromVersion} → ${entry.toVersion}`;
}

export function registerMigrate(program: Command): void {
  const migrate = program.command('migrate').description('Forward-only data migrations (plan / apply / status / list).');

  migrate
    .command('list')
    .description('List every registered migration with its version range and layer.')
    .option('--json', 'Emit machine-readable JSON.', false)
    .action(async (opts: { json: boolean }) => {
      await withMigrationApi(async (api) => {
        const rows = api.list();
        if (opts.json) {
          console.log(JSON.stringify(rows, null, 2));
          return;
        }
        if (rows.length === 0) {
          console.log('No migrations are registered.');
          return;
        }
        console.log('ID                        from → to    layer       severity    description');
        for (const r of rows) {
          console.log(`${r.id.padEnd(25)} ${formatRange(r).padEnd(12)} ${r.layer.padEnd(11)} ${`[${r.severity}]`.padEnd(11)} ${r.description}`);
        }
      });
    });

  migrate
    .command('plan')
    .description('Preview pending migrations (preflight by default).')
    .option('--all-layers', 'Include boot-layer migrations as well as preflight.', false)
    .option('--json', 'Emit machine-readable JSON.', false)
    .action(async (opts: { allLayers: boolean; json: boolean }) => {
      await withMigrationApi(async (api) => {
        const entries = await api.plan({ allLayers: opts.allLayers });
        if (opts.json) {
          console.log(JSON.stringify({ latestTarget: api.latestTarget(), entries }, null, 2));
          return;
        }
        console.log(`Latest target: ${api.latestTarget() ?? '(none)'}`);
        console.log('');
        const pending = entries.filter((e) => e.pending);
        if (pending.length === 0) {
          console.log('No pending migrations.');
          return;
        }
        pending.forEach((e, i) => {
          console.log(`  [${i + 1}/${pending.length}] ${e.id.padEnd(25)} [${e.severity}] (${formatRange(e)})`);
          console.log(`        ${e.description}`);
          console.log(`        ${e.detail ? `Detected: ${e.detail.summary}` : 'Detected: details unavailable (no detect stage; isPending = true)'}`);
        });
        console.log('');
        console.log('Run `crowi-admin migrate apply` to execute preflight migrations.');
      });
    });

  migrate
    .command('apply')
    .description('Apply pending migrations (preflight by default), in version-range + order sequence.')
    .option('--all-layers', 'Include boot-layer migrations as well as preflight.', false)
    .option('--dry-run', 'Run detect only; stages no-op and nothing is recorded.', false)
    .option('--id <id>', 'Apply only the migration with this id.')
    .option('--continue-on-error', 'Continue with later migrations after a failure (default: abort).', false)
    .action(async (opts: { allLayers: boolean; dryRun: boolean; id?: string; continueOnError: boolean }) => {
      await withMigrationApi(async (api) => {
        const outcomes = await api.apply({ allLayers: opts.allLayers, dryRun: opts.dryRun, id: opts.id, continueOnError: opts.continueOnError });
        if (outcomes.length === 0) {
          console.log('No migrations to apply.');
          return;
        }
        for (const o of outcomes) {
          console.log(`  ${o.id.padEnd(25)} → ${o.result} (${o.durationMs}ms)`);
        }
        const failed = outcomes.filter((o) => o.result === 'failed');
        if (failed.length > 0) {
          throw new Error(`${failed.length} migration(s) failed: ${failed.map((f) => f.id).join(', ')}`);
        }
      });
    });

  migrate
    .command('status')
    .description('Show recent migration applications and pending counts.')
    .option('--json', 'Emit machine-readable JSON.', false)
    .action(async (opts: { json: boolean }) => {
      await withMigrationApi(async (api) => {
        const status = await api.status();
        if (opts.json) {
          console.log(JSON.stringify(status, null, 2));
          return;
        }
        console.log(`Latest target: ${status.latestTarget ?? '(none)'}`);
        console.log('');
        console.log('Recent applications (last 10):');
        if (status.recent.length === 0) {
          console.log('  (none)');
        } else {
          for (const r of status.recent) {
            const date = r.appliedAt.toISOString().slice(0, 10);
            const elapsed = r.durationMs !== undefined ? `${r.durationMs}ms` : '-';
            console.log(`  ${date}  ${r.result.padEnd(14)} ${r.migrationId.padEnd(25)} (${elapsed}, ${r.appliedBy ?? '-'})`);
          }
        }
        console.log('');
        console.log(`Pending preflight:  ${status.pendingPreflight} migration(s)`);
        console.log(`Pending boot:       ${status.pendingBoot} migration(s)`);
      });
    });
}
