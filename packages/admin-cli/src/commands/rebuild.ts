import path from 'node:path';
import dotenv from 'dotenv';
import type { Command } from 'commander';

/**
 * RFC-0008 §8.5 — the `crowi-admin rebuild <target>` namespace.
 *
 * Operational rebuilds of derived data — version-independent, runnable any
 * time, any number of times (no pending/applied concept). All targets route
 * through the api-side `RebuildRunner`, so they share the framework runner's
 * `--dry-run` / progress / SIGINT / structured-logging conventions with
 * `migrate` (§4.3) — but a rebuild never touches `migrationApplications`
 * (§8.5).
 *
 * Targets:
 *   - `rebuild search`        ← ported from the old top-level `search rebuild`
 *   - `rebuild storage copy`  ← ported from the old top-level `storage copy`
 *   - `rebuild renderer`      ← new; util/rebuild-renderer.ts skeleton (TODO)
 *   - `rebuild backlink`      ← new; util/rebuild-backlink.ts skeleton (TODO)
 *
 * Like the other admin commands, this loads the api's compiled `dist/` lazily
 * (see `storage-copy.ts` for the `require.resolve` rationale — we avoid
 * importing `@crowi/api` directly so its `app.ts` auto-boot doesn't fire) and
 * talks to MongoDB directly.
 */

/** Minimal structural mirror of the api-side `RebuildOutcome`. */
interface RebuildOutcome {
  id: string;
  durationMs: number;
  interrupted: boolean;
  stats: Record<string, unknown>;
}
interface RebuildProgress {
  onLabel?: (label: string) => void;
  onIncrement?: (current: number) => void;
}
interface RebuildCliApi {
  rebuildSearch(opts?: { dryRun?: boolean; progress?: RebuildProgress }): Promise<RebuildOutcome>;
  rebuildStorageCopy(opts: { from: string; to: string; dryRun?: boolean; progress?: RebuildProgress }): Promise<RebuildOutcome>;
  rebuildRenderer(opts?: { onlyStale?: boolean; dryRun?: boolean; progress?: RebuildProgress }): Promise<RebuildOutcome>;
  rebuildBacklink(opts?: { dryRun?: boolean; progress?: RebuildProgress }): Promise<RebuildOutcome>;
}

interface ApiCrowi {
  initForCli(): Promise<void>;
  teardownForCli(): Promise<void>;
}
interface ApiCrowiCtor {
  new (rootDir: string, env: NodeJS.ProcessEnv): ApiCrowi;
}
type CreateRebuildCliApi = (crowi: ApiCrowi) => RebuildCliApi;

function loadApi(): { Crowi: ApiCrowiCtor; createRebuildCliApi: CreateRebuildCliApi } | null {
  let apiPkgPath: string;
  try {
    apiPkgPath = require.resolve('@crowi/api/package.json', { paths: [process.cwd(), __dirname] });
  } catch {
    return null;
  }
  const apiRoot = path.dirname(apiPkgPath);
  const distDir = path.join(apiRoot, 'dist');

  const crowiModule = require(path.join(distDir, 'crowi')) as { default: ApiCrowiCtor };
  const apiModule = require(path.join(distDir, 'migration', 'rebuild-api')) as { createRebuildCliApi: CreateRebuildCliApi };

  return { Crowi: crowiModule.default, createRebuildCliApi: apiModule.createRebuildCliApi };
}

/**
 * Map a completed rebuild outcome to a process exit code, mirroring the legacy
 * storage-copy convention:
 *   - 0 — success (everything copied / rebuilt, or dry-run)
 *   - 2 — partial: the run completed but >=1 unit failed (operator should retry)
 *
 * Kept as a pure function (no `process.exit`) so the partial→2 mapping is unit
 * testable without the surrounding boot ceremony. `process.exit(code)` ignores
 * `process.exitCode`, so the exit code must flow through here and be passed
 * explicitly — a fn that merely sets `process.exitCode = 2` would be clobbered
 * by the `process.exit(0)` in `withRebuildApi`.
 *
 * Fatal failures (init failed, or a task threw — e.g. renderer/backlink NOT_YET)
 * are exit 1 and handled in `withRebuildApi`; they never reach here.
 */
export function rebuildExitCode(outcome: RebuildOutcome): number {
  const failed = outcome.stats.failed;
  if (typeof failed === 'number' && failed > 0) return 2;
  return 0;
}

/**
 * Boot a lightweight Crowi, hand the rebuild façade to `fn`, then tear it
 * down. Centralizes the .env load / loadApi guard / init / teardown ceremony
 * shared by every `rebuild` subcommand.
 *
 * `fn` returns the success exit code (0 normally, 2 for a partial run — see
 * `rebuildExitCode`); a fatal failure (init error or a thrown task) overrides
 * it with exit 1. The resolved code is passed explicitly to `process.exit`,
 * since an explicit argument ignores any `process.exitCode` a callee set.
 */
async function withRebuildApi(fn: (api: RebuildCliApi) => Promise<number | void>): Promise<void> {
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
    exitCode = (await fn(loaded.createRebuildCliApi(crowi))) ?? 0;
  } catch (err) {
    console.error('crowi-admin: rebuild failed.');
    printError(err);
    exitCode = 1;
  } finally {
    await crowi.teardownForCli().catch(() => undefined);
  }
  process.exit(exitCode);
}

export function registerRebuild(program: Command): void {
  const rebuild = program.command('rebuild').description('Operational rebuilds of derived data (renderer / search / backlink / storage copy).');

  rebuild
    .command('renderer')
    .description('Regenerate cached rendered HTML for pages.')
    .option('--only-stale', 'Only re-render pages whose cache is stale.', false)
    .option('--dry-run', 'Report what would be rebuilt without writing.', false)
    .action(async (opts: { onlyStale: boolean; dryRun: boolean }) => {
      await withRebuildApi(async (api) => {
        const outcome = await api.rebuildRenderer({ onlyStale: opts.onlyStale, dryRun: opts.dryRun, progress: liveProgress() });
        printOutcome('renderer', outcome);
      });
    });

  rebuild
    .command('search')
    .description("Rebuild the search index from scratch using the active driver's rebuild().")
    .option('--dry-run', 'Report what would be rebuilt without writing.', false)
    .action(async (opts: { dryRun: boolean }) => {
      await withRebuildApi(async (api) => {
        const outcome = await api.rebuildSearch({ dryRun: opts.dryRun, progress: liveProgress() });
        printOutcome('search', outcome);
      });
    });

  rebuild
    .command('backlink')
    .description('Rebuild the backlink index across all pages.')
    .option('--dry-run', 'Report what would be rebuilt without writing.', false)
    .action(async (opts: { dryRun: boolean }) => {
      await withRebuildApi(async (api) => {
        const outcome = await api.rebuildBacklink({ dryRun: opts.dryRun, progress: liveProgress() });
        printOutcome('backlink', outcome);
      });
    });

  const storage = rebuild.command('storage').description('Storage driver rebuilds.');
  storage
    .command('copy')
    .description('Copy every stored object from one driver to another.')
    .requiredOption('--from <name>', 'Source storage driver name (e.g. local, s3).')
    .requiredOption('--to <name>', 'Destination storage driver name.')
    .option('--dry-run', 'List candidate keys without copying anything.', false)
    .action(async (opts: { from: string; to: string; dryRun: boolean }) => {
      await withRebuildApi(async (api) => {
        const outcome = await api.rebuildStorageCopy({ from: opts.from, to: opts.to, dryRun: opts.dryRun, progress: liveProgress() });
        printOutcome('storage copy', outcome);
        // Mirror the legacy exit-code convention: partial (>=1 key failed) → 2.
        return rebuildExitCode(outcome);
      });
    });
}

/**
 * A progress sink that renders the runner's per-unit label to stderr so a
 * long rebuild shows live activity without flooding stdout (which carries the
 * final summary). Mirrors the spirit of `storage-copy.ts`'s `renderProgress`.
 */
function liveProgress(): RebuildProgress {
  return {
    onLabel: (label) => {
      // Single-line, low-noise: enough to confirm the run is alive.
      process.stderr.write(`  ${label}\n`);
    },
  };
}

/** Print the final summary block, including each stat key the task returned. */
function printOutcome(target: string, outcome: RebuildOutcome): void {
  console.log('');
  console.log('--- summary ---');
  console.log(`target:   ${target}`);
  for (const [key, value] of Object.entries(outcome.stats)) {
    console.log(`${`${key}:`.padEnd(10)}${formatStat(value)}`);
  }
  console.log(`elapsed:  ${formatElapsed(outcome.durationMs)}`);
  if (outcome.interrupted) {
    console.log('');
    console.log('Interrupted by SIGINT before completion — re-run to finish.');
    return;
  }
  console.log('');
  console.log(`Rebuild '${target}' complete.`);
}

function formatStat(value: unknown): string {
  if (Array.isArray(value)) return value.length === 0 ? '(none)' : value.join(', ');
  return String(value);
}

/**
 * Render whatever detail we can extract from a thrown error. The ES JS
 * client's `ResponseError` puts the cluster's actual response on `meta.body`
 * and leaves `.message` as just the HTTP status string, so walk the common
 * shapes (preserved from the old `search rebuild` command).
 */
function printError(err: unknown): void {
  if (err instanceof Error) {
    if (err.message) console.error(`  message: ${err.message}`);
    const meta = (err as Error & { meta?: { statusCode?: number; body?: unknown } }).meta;
    if (meta) {
      if (meta.statusCode !== undefined) console.error(`  status:  ${meta.statusCode}`);
      if (meta.body !== undefined) {
        try {
          console.error(`  body:    ${JSON.stringify(meta.body, null, 2)}`);
        } catch {
          console.error(`  body:    ${String(meta.body)}`);
        }
      }
    }
    const cause = (err as Error & { cause?: unknown }).cause;
    if (cause !== undefined) console.error(`  cause:   ${cause instanceof Error ? cause.message || cause.name : String(cause)}`);
    if (err.stack) console.error(err.stack);
  } else {
    console.error(`  thrown:  ${String(err)}`);
  }
}

/** Render an elapsed millisecond duration ("412ms" / "28m12s"). */
function formatElapsed(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const totalSeconds = Math.round(ms / 1000);
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}m${seconds.toString().padStart(2, '0')}s`;
}
