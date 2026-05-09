import path from 'node:path';
import dotenv from 'dotenv';
import type { Command } from 'commander';

/**
 * Resolve the @crowi/api package's installed location relative to the
 * caller's CWD (= the runner directory) and load the bits we need:
 *   - the `Crowi` class (default export of crowi/index)
 *   - the `runStorageCopy` helper
 *
 * Why dynamic require?
 *   - `@crowi/api` declares `main: src/app.ts` which auto-boots the
 *     server when imported the obvious way. We need the lower-level
 *     entry points instead.
 *   - The CLI runs inside the operator's runner directory, so node's
 *     resolution rooted at `process.cwd()` finds the right copy of
 *     @crowi/api (a workspace symlink in dev, an npm install in prod).
 *
 * Returns `null` when the API package isn't installed at the expected
 * path so the caller can print a helpful error instead of a stack trace.
 */
function loadApi(): { Crowi: ApiCrowiCtor; runStorageCopy: RunStorageCopy } | null {
  let apiPkgPath: string;
  try {
    apiPkgPath = require.resolve('@crowi/api/package.json', { paths: [process.cwd(), __dirname] });
  } catch {
    return null;
  }
  const apiRoot = path.dirname(apiPkgPath);
  const distDir = path.join(apiRoot, 'dist');

  // @crowi/api ships with `main: src/app.ts` (because that's what the
  // production runner invokes via `node dist/app.js`), so we can't rely
  // on `require('@crowi/api')` doing the right thing — that would try
  // to execute the .ts entry point. Reach into dist/ directly. The dist
  // is already alias-resolved by tsc-alias at build time, so we don't
  // need a runtime `module-alias` registration step.
  const crowiModule = require(path.join(distDir, 'crowi')) as { default: ApiCrowiCtor };
  const copyModule = require(path.join(distDir, 'util', 'storage-copy')) as { runStorageCopy: RunStorageCopy };

  return { Crowi: crowiModule.default, runStorageCopy: copyModule.runStorageCopy };
}

/**
 * Minimal structural types describing the bits of @crowi/api the CLI
 * uses. We don't import the full types because doing so would re-boot
 * the package's type graph in admin-cli's tsc pass (huge slowdown);
 * keep the surface small and let the runtime check enforce shape.
 */
interface ApiCrowi {
  initForCli(): Promise<void>;
  teardownForCli(): Promise<void>;
}
interface ApiCrowiCtor {
  new (rootDir: string, env: NodeJS.ProcessEnv): ApiCrowi;
}
interface CopyOptions {
  from: string;
  to: string;
  dryRun: boolean;
  onProgress?: (event: ProgressEvent) => void;
}
interface ProgressEvent {
  current: number;
  total: number | null;
  key: string;
  stage: 'start' | 'ok' | 'failed' | 'skipped';
  reason?: string;
}
interface CopySummary {
  ok: number;
  failed: number;
  skipped: number;
  total: number;
  sampleKeys: string[];
}
type RunStorageCopy = (crowi: ApiCrowi, opts: CopyOptions) => Promise<CopySummary>;

/**
 * Wire the `storage copy` subcommand into the root program.
 *
 * Matches the spec's invocation:
 *   crowi-admin storage copy --from <a> --to <b> [--dry-run]
 */
export function registerStorageCopy(program: Command): void {
  const storage = program.command('storage').description('Storage driver utilities (copy / inspect).');

  storage
    .command('copy')
    .description('Copy every stored object from one driver to another.')
    .requiredOption('--from <name>', 'Source storage driver name (e.g. local, s3).')
    .requiredOption('--to <name>', 'Destination storage driver name.')
    .option('--dry-run', 'List candidate keys without copying anything.', false)
    .action(async (opts: { from: string; to: string; dryRun: boolean }) => {
      // Load .env from the CWD (runner directory) so MONGO_URI /
      // CROWI_ENCRYPTION_KEY / etc. flow through to Crowi's constructor
      // the same way `apps/crowi-api/src/app.ts` loads them at server
      // boot. Silent if no .env file is present.
      dotenv.config();

      const api = loadApi();
      if (!api) {
        console.error('crowi-admin: could not locate @crowi/api. Run from a directory that has @crowi/api installed (e.g. the runner package).');
        process.exit(1);
      }

      // CWD is the runner directory; PluginManager's bootstrap defaults
      // to `process.cwd()` for plugin resolution + crowi.config.json
      // discovery. Pass the same path to Crowi so its `rootDir` is
      // consistent with the server boot path.
      const crowi = new api.Crowi(process.cwd(), process.env);

      console.log(`[crowi-admin] storage copy: from=${opts.from} to=${opts.to}${opts.dryRun ? ' (dry-run)' : ''}`);

      try {
        await crowi.initForCli();
      } catch (err) {
        console.error('crowi-admin: failed to initialise Crowi:', (err as Error).message);
        await crowi.teardownForCli().catch(() => undefined);
        process.exit(1);
      }

      // Exit-code convention:
      //   0 — everything copied successfully (or dry-run completed)
      //   1 — fatal: init failed, or runStorageCopy threw before any work
      //   2 — partial: copy ran but >=1 key failed (operator should retry)
      let exitCode = 0;
      try {
        const summary = await api.runStorageCopy(crowi, {
          from: opts.from,
          to: opts.to,
          dryRun: opts.dryRun,
          onProgress: (event) => renderProgress(event, opts.dryRun),
        });
        printSummary(summary, opts.dryRun);
        if (summary.failed > 0) exitCode = 2;
      } catch (err) {
        console.error('crowi-admin: storage copy failed:', (err as Error).message);
        exitCode = 1;
      } finally {
        await crowi.teardownForCli().catch(() => undefined);
      }
      process.exit(exitCode);
    });
}

/**
 * Per-key progress renderer. Dry-run emits the candidate keys (so the
 * operator can sanity-check the count); non-dry-run emits ok / failed
 * lines so partial progress is visible during long copies. The `start`
 * event is intentionally swallowed — the matching `ok` / `failed` event
 * includes the same key.
 */
function renderProgress(event: ProgressEvent, dryRun: boolean): void {
  switch (event.stage) {
    case 'start':
      return;
    case 'ok':
      console.log(`  [${event.current}] ok    ${event.key}`);
      return;
    case 'failed':
      console.log(`  [${event.current}] FAIL  ${event.key} — ${event.reason ?? 'unknown'}`);
      return;
    case 'skipped':
      if (dryRun) console.log(`  [${event.current}] DRY   ${event.key}`);
      return;
  }
}

/**
 * Print the final summary block. Format chosen to be diff-able in the
 * operator's terminal scrollback:
 *
 *   --- summary ---
 *   total:    123
 *   ok:       121
 *   failed:   0
 *   skipped:  2
 */
function printSummary(summary: CopySummary, dryRun: boolean): void {
  console.log('');
  console.log(dryRun ? '--- dry-run summary ---' : '--- summary ---');
  console.log(`total:    ${summary.total}`);
  console.log(`ok:       ${summary.ok}`);
  console.log(`failed:   ${summary.failed}`);
  console.log(`skipped:  ${summary.skipped}`);
  if (dryRun && summary.sampleKeys.length > 0) {
    console.log('');
    console.log(`first ${summary.sampleKeys.length} candidate key(s):`);
    for (const key of summary.sampleKeys) console.log(`  ${key}`);
  }
}
