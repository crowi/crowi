import path from 'node:path';
import dotenv from 'dotenv';
import type { Command } from 'commander';

/**
 * Resolve @crowi/api's installed location relative to the caller's CWD
 * (= the runner directory) and load the bits we need, the same way
 * `search-rebuild.ts` / `storage-copy.ts` do (manual `require` so
 * `@crowi/api`'s `app.ts` auto-boot doesn't fire). Returns `null` when
 * the package isn't found so the caller can print a friendly error.
 */
function loadApi(): { Crowi: ApiCrowiCtor; runWatcherBackfill: RunWatcherBackfill } | null {
  let apiPkgPath: string;
  try {
    apiPkgPath = require.resolve('@crowi/api/package.json', { paths: [process.cwd(), __dirname] });
  } catch {
    return null;
  }
  const distDir = path.join(path.dirname(apiPkgPath), 'dist');
  const crowiModule = require(path.join(distDir, 'crowi')) as { default: ApiCrowiCtor };
  const backfillModule = require(path.join(distDir, 'util', 'watcher-backfill')) as { runWatcherBackfill: RunWatcherBackfill };
  return { Crowi: crowiModule.default, runWatcherBackfill: backfillModule.runWatcherBackfill };
}

interface ApiCrowi {
  initForCli(): Promise<void>;
  teardownForCli(): Promise<void>;
}
interface ApiCrowiCtor {
  new (rootDir: string, env: NodeJS.ProcessEnv): ApiCrowi;
}
interface WatcherBackfillSummary {
  pagesScanned: number;
  watchersCreated: number;
  dryRun: boolean;
}
type RunWatcherBackfill = (crowi: ApiCrowi, opts?: { dryRun?: boolean }) => Promise<WatcherBackfillSummary>;

/**
 * Wire the `watcher backfill` subcommand into the root program.
 *
 * Invocation:
 *   crowi-admin watcher backfill [--dry-run]
 *
 * One-shot migration for pages that predate auto-watch: materialises a
 * WATCH row for each page's implicit notification set (creator + comment
 * authors + revision authors), respecting existing IGNORE opt-outs and
 * existing WATCH rows. Idempotent — safe to re-run. See
 * `@crowi/api`'s `util/watcher-backfill.ts` for the semantics.
 */
export function registerWatcherBackfill(program: Command): void {
  const watcher = program.command('watcher').description('Watcher / notification subscription utilities.');

  watcher
    .command('backfill')
    .description('Backfill WATCH rows for pages created before auto-watch (creator + comment/revision authors). Idempotent.')
    .option('--dry-run', 'Report how many WATCH rows would be created without writing anything.', false)
    .action(async (opts: { dryRun?: boolean }) => {
      // Load .env so MONGO_URI / CROWI_ENCRYPTION_KEY flow into Crowi the
      // same way `app.ts` does at boot. Silent if no .env present.
      dotenv.config();

      const api = loadApi();
      if (!api) {
        console.error('crowi-admin: could not locate @crowi/api. Run from a directory that has @crowi/api installed (e.g. the runner package).');
        process.exit(1);
      }

      const crowi = new api.Crowi(process.cwd(), process.env);
      const dryRun = Boolean(opts.dryRun);
      console.log(`[crowi-admin] watcher backfill: starting${dryRun ? ' (dry-run)' : ''}`);

      try {
        await crowi.initForCli();
      } catch (err) {
        console.error('crowi-admin: failed to initialise Crowi:', (err as Error).message);
        await crowi.teardownForCli().catch(() => undefined);
        process.exit(1);
      }

      let exitCode = 0;
      try {
        const startedAt = Date.now();
        const summary = await api.runWatcherBackfill(crowi, { dryRun });
        const elapsedMs = Date.now() - startedAt;
        console.log('');
        console.log('--- summary ---');
        console.log(`pages scanned:    ${summary.pagesScanned}`);
        console.log(`watchers ${summary.dryRun ? 'to create' : 'created'}: ${summary.watchersCreated}`);
        console.log(`elapsed:          ${formatElapsed(elapsedMs)}`);
        console.log('');
        console.log(summary.dryRun ? 'Dry-run complete — no rows written.' : 'Backfill complete.');
      } catch (err) {
        console.error('crowi-admin: watcher backfill failed.');
        if (err instanceof Error) {
          if (err.message) console.error(`  message: ${err.message}`);
          if (err.stack) console.error(err.stack);
        } else {
          console.error(`  thrown:  ${String(err)}`);
        }
        exitCode = 1;
      } finally {
        await crowi.teardownForCli().catch(() => undefined);
      }
      process.exit(exitCode);
    });
}

/** Elapsed-duration formatter (mirrors search-rebuild's). */
function formatElapsed(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const totalSeconds = Math.round(ms / 1000);
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}m${seconds.toString().padStart(2, '0')}s`;
}
