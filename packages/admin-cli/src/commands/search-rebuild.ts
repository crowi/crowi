import path from 'node:path';
import dotenv from 'dotenv';
import type { Command } from 'commander';

/**
 * Resolve the @crowi/api package's installed location relative to the
 * caller's CWD (= the runner directory) and load the bits we need. See
 * `storage-copy.ts` for the rationale on `require.resolve` + manual
 * `require` indirection (we avoid importing `@crowi/api` directly so
 * its `app.ts` auto-boot doesn't fire).
 *
 * Returns `null` when the API package isn't installed at the expected
 * path so the caller can print a helpful error instead of a stack trace.
 */
function loadApi(): { Crowi: ApiCrowiCtor; runSearchRebuild: RunSearchRebuild } | null {
  let apiPkgPath: string;
  try {
    apiPkgPath = require.resolve('@crowi/api/package.json', { paths: [process.cwd(), __dirname] });
  } catch {
    return null;
  }
  const apiRoot = path.dirname(apiPkgPath);
  const distDir = path.join(apiRoot, 'dist');

  const crowiModule = require(path.join(distDir, 'crowi')) as { default: ApiCrowiCtor };
  const rebuildModule = require(path.join(distDir, 'util', 'search-rebuild')) as { runSearchRebuild: RunSearchRebuild };

  return { Crowi: crowiModule.default, runSearchRebuild: rebuildModule.runSearchRebuild };
}

interface ApiCrowi {
  initForCli(): Promise<void>;
  teardownForCli(): Promise<void>;
}
interface ApiCrowiCtor {
  new (rootDir: string, env: NodeJS.ProcessEnv): ApiCrowi;
}
interface RebuildSummary {
  driverName: string;
  pluginName: string;
}
type RunSearchRebuild = (crowi: ApiCrowi) => Promise<RebuildSummary>;

/**
 * Wire the `search rebuild` subcommand into the root program.
 *
 * Invocation:
 *   crowi-admin search rebuild
 *
 * Plugin-agnostic: this command resolves the active search driver and
 * delegates to its `rebuild()`. The actual rebuild logic (alias swap,
 * bulk indexing, etc.) lives in the plugin's driver — see the
 * `SearchDriver.rebuild?()` contract in `@crowi/plugin-api`.
 */
export function registerSearchRebuild(program: Command): void {
  const search = program.command('search').description('Search driver utilities (rebuild / inspect).');

  search
    .command('rebuild')
    .description("Rebuild the search index from scratch using the active driver's rebuild() implementation.")
    .action(async () => {
      // Load .env so MONGO_URI / CROWI_ENCRYPTION_KEY / etc. flow through
      // to Crowi's constructor the same way `packages/api/src/app.ts`
      // does at server boot. Silent if no .env file is present.
      dotenv.config();

      const api = loadApi();
      if (!api) {
        console.error('crowi-admin: could not locate @crowi/api. Run from a directory that has @crowi/api installed (e.g. the runner package).');
        process.exit(1);
      }

      const crowi = new api.Crowi(process.cwd(), process.env);

      console.log('[crowi-admin] search rebuild: starting');

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
        const summary = await api.runSearchRebuild(crowi);
        const elapsedMs = Date.now() - startedAt;
        console.log('');
        console.log('--- summary ---');
        console.log(`driver:   ${summary.driverName}`);
        console.log(`plugin:   ${summary.pluginName}`);
        console.log(`elapsed:  ${formatElapsed(elapsedMs)}`);
        console.log('');
        console.log('Index rebuild complete.');
      } catch (err) {
        // ES client errors often have an empty `.message` and put the
        // useful detail on `.meta.body.error` (or wrap an HTTP cause).
        // Print everything we can find so operators don't have to dig
        // through plugin source to interpret a failure.
        console.error('crowi-admin: search rebuild failed.');
        printError(err);
        exitCode = 1;
      } finally {
        await crowi.teardownForCli().catch(() => undefined);
      }
      process.exit(exitCode);
    });
}

/**
 * Render whatever detail we can extract from a thrown error. The ES JS
 * client's `ResponseError` puts the cluster's actual response on
 * `meta.body` and leaves `.message` as just the HTTP status string,
 * which on its own is useless ("response error"). Walk the common
 * shapes so operators can act on the output without needing to attach
 * a debugger.
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

/**
 * Render an elapsed millisecond duration for the summary block. Picks
 * the unit based on magnitude so a 30-minute rebuild reads naturally
 * ("28m12s") and a quick test cluster rebuild reads as "412ms".
 */
function formatElapsed(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const totalSeconds = Math.round(ms / 1000);
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}m${seconds.toString().padStart(2, '0')}s`;
}
