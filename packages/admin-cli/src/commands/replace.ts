import path from 'node:path';
import readline from 'node:readline/promises';
import type { Command } from 'commander';
import dotenv from 'dotenv';

/**
 * feature-url-replace-admin-cli — the `crowi-admin replace` namespace.
 *
 * `replace url --from <url> --to <url>` swaps a literal URL/host string in every
 * page body — the fix for a v1→v2 migration that changed the public domain and
 * left absolute URLs (image embeds / links) pinned to the old host. Page / file
 * ids are carried over unchanged, so this is a literal host swap, not an id remap.
 *
 * Like the other admin commands this loads the api's compiled `dist/` lazily
 * (see `migrate.ts` for the `require.resolve` rationale — we avoid importing
 * `@crowi/api` directly so its `app.ts` auto-boot doesn't fire) and talks to
 * MongoDB directly. The heavy lifting (scan + quiet rewrite that pushes a new
 * revision WITHOUT bumping updatedAt / notifying watchers) lives in
 * `@crowi/api`'s `util/replace-url.ts`; this file is the CLI surface:
 * arg-safety guard, preview, confirmation, summary, exit code.
 */

/** Structural mirror of the api-side `ReplaceSafety`. */
interface ReplaceSafety {
  errors: string[];
  warnings: string[];
  bareHostFrom: boolean;
}
/** Structural mirror of the api-side preview / summary shapes. */
interface ReplaceUrlSample {
  path: string;
  occurrences: number;
  snippet: string;
}
interface ReplaceUrlPreview {
  pagesMatched: number;
  occurrences: number;
  samples: ReplaceUrlSample[];
}
interface ReplaceUrlSummary extends ReplaceUrlPreview {
  from: string;
  to: string;
  dryRun: boolean;
  aborted: boolean;
  pagesScanned: number;
  pagesRewritten: number;
  failed: number;
  interrupted: boolean;
  actingUserEmail?: string;
}
interface ReplaceUrlOptions {
  from: string;
  to: string;
  userEmail?: string;
  dryRun?: boolean;
  includeTrash?: boolean;
  confirm?: (preview: ReplaceUrlPreview) => Promise<boolean>;
}

interface ApiCrowi {
  initForCli(): Promise<void>;
  teardownForCli(): Promise<void>;
}
interface ApiCrowiCtor {
  new (rootDir: string, env: NodeJS.ProcessEnv): ApiCrowi;
}
type RunReplaceUrl = (crowi: ApiCrowi, opts: ReplaceUrlOptions) => Promise<ReplaceUrlSummary>;
type AssessReplaceSafety = (from: string, to: string) => ReplaceSafety;

function loadApi(): { Crowi: ApiCrowiCtor; runReplaceUrl: RunReplaceUrl; assessReplaceSafety: AssessReplaceSafety } | null {
  let apiPkgPath: string;
  try {
    apiPkgPath = require.resolve('@crowi/api/package.json', { paths: [process.cwd(), __dirname] });
  } catch {
    return null;
  }
  const distDir = path.join(path.dirname(apiPkgPath), 'dist');
  const crowiModule = require(path.join(distDir, 'crowi')) as { default: ApiCrowiCtor };
  const replaceModule = require(path.join(distDir, 'util', 'replace-url')) as { runReplaceUrl: RunReplaceUrl; assessReplaceSafety: AssessReplaceSafety };
  return { Crowi: crowiModule.default, runReplaceUrl: replaceModule.runReplaceUrl, assessReplaceSafety: replaceModule.assessReplaceSafety };
}

/**
 * Map a completed summary to a process exit code (mirrors `rebuildExitCode`):
 *   - 2 — partial: the run finished but >=1 page failed (operator should retry)
 *   - 0 — success / dry-run / declined
 * Fatal failures (init / thrown) are exit 1 and handled in the action.
 */
export function replaceExitCode(summary: { failed: number }): number {
  return summary.failed > 0 ? 2 : 0;
}

export function registerReplace(program: Command): void {
  const replace = program.command('replace').description('Bulk content replacements across page bodies.');

  replace
    .command('url')
    .description(
      'Replace a literal URL/host string in every page body (e.g. after a domain change). Pushes a new revision per page WITHOUT bumping updatedAt or notifying watchers.',
    )
    .requiredOption('--from <s>', 'String to replace. Use a full origin to be safe, e.g. https://old.example.')
    .requiredOption('--to <s>', 'Replacement string, e.g. https://new.example.')
    .option('--dry-run', 'Report what would change without writing.', false)
    .option('--include-trash', 'Also rewrite trashed / deprecated pages (default: published only).', false)
    .option('--user <email>', 'Author recorded on the new revisions (defaults to the oldest admin).')
    .option('--yes', 'Skip the interactive confirmation prompt.', false)
    .option('--force', 'Proceed even when --from looks unsafe (e.g. a bare host without a scheme).', false)
    .action(async (opts: { from: string; to: string; dryRun?: boolean; includeTrash?: boolean; user?: string; yes?: boolean; force?: boolean }) => {
      // Load .env so MONGO_URI / CROWI_ENCRYPTION_KEY flow into Crowi the same
      // way app.ts does at boot. Silent if no .env present.
      dotenv.config();

      const api = loadApi();
      if (!api) {
        console.error('crowi-admin: could not locate @crowi/api. Run from a directory that has @crowi/api installed (e.g. the runner package).');
        process.exit(1);
      }

      const from = String(opts.from);
      const to = String(opts.to);

      // Cheap pre-flight guard (no DB): fail fast on footguns before booting.
      const safety = api.assessReplaceSafety(from, to);
      for (const w of safety.warnings) console.warn(`crowi-admin: warning: ${w}`);
      if (safety.errors.length > 0) {
        for (const e of safety.errors) console.error(`crowi-admin: ${e}`);
        process.exit(1);
      }
      if (safety.bareHostFrom && !opts.force) {
        console.error(
          `crowi-admin: --from='${from}' has no scheme. A bare host can corrupt longer hosts that start with it (e.g. '${from}' is a prefix of '${from}t'). Re-run with a full origin (e.g. https://${from}) or pass --force to override.`,
        );
        process.exit(1);
      }

      const crowi = new api.Crowi(process.cwd(), process.env);
      console.log(`[crowi-admin] replace url: '${from}' → '${to}'${opts.dryRun ? ' (dry-run)' : ''}`);

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
        const summary = await api.runReplaceUrl(crowi, {
          from,
          to,
          userEmail: opts.user,
          dryRun: Boolean(opts.dryRun),
          includeTrash: Boolean(opts.includeTrash),
          confirm: opts.dryRun ? undefined : (preview) => confirmProceed(preview, Boolean(opts.yes)),
        });
        printSummary(summary, Date.now() - startedAt);
        exitCode = replaceExitCode(summary);
      } catch (err) {
        console.error('crowi-admin: replace url failed.');
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

/** Print the matched pages + samples, then ask for confirmation (unless --yes). */
async function confirmProceed(preview: ReplaceUrlPreview, yes: boolean): Promise<boolean> {
  printPreview(preview);
  if (preview.pagesMatched === 0) return false; // nothing to do
  if (yes) return true;
  // A bulk body rewrite is hard to undo en masse, so refuse to write blind.
  if (!process.stdin.isTTY) {
    console.error('');
    console.error('crowi-admin: refusing to write without confirmation (no TTY). Re-run with --yes to proceed, or --dry-run to preview.');
    return false;
  }
  const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
  try {
    const answer = (await rl.question(`Rewrite ${preview.pagesMatched} page(s)? [y/N] `)).trim().toLowerCase();
    return answer === 'y' || answer === 'yes';
  } finally {
    rl.close();
  }
}

function printPreview(preview: ReplaceUrlPreview): void {
  console.log('');
  console.log(`Matched ${preview.pagesMatched} page(s), ${preview.occurrences} occurrence(s).`);
  for (const s of preview.samples) {
    console.log(`  ${s.path}  (${s.occurrences})  ${s.snippet}`);
  }
  const more = preview.pagesMatched - preview.samples.length;
  if (more > 0) console.log(`  … and ${more} more page(s)`);
}

function printSummary(summary: ReplaceUrlSummary, elapsedMs: number): void {
  console.log('');
  console.log('--- summary ---');
  console.log(`from:      ${summary.from}`);
  console.log(`to:        ${summary.to}`);
  console.log(`scanned:   ${summary.pagesScanned} page(s)`);
  console.log(`matched:   ${summary.pagesMatched} page(s), ${summary.occurrences} occurrence(s)`);

  if (summary.pagesMatched === 0) {
    console.log('');
    console.log(`No pages contain '${summary.from}'.`);
    return;
  }

  if (summary.dryRun) {
    for (const s of summary.samples) {
      console.log(`  ${s.path}  (${s.occurrences})  ${s.snippet}`);
    }
    const more = summary.pagesMatched - summary.samples.length;
    if (more > 0) console.log(`  … and ${more} more page(s)`);
    console.log('');
    console.log('Dry-run complete — no pages written.');
    return;
  }

  if (summary.aborted) {
    console.log('');
    console.log('Aborted — no pages written.');
    return;
  }

  console.log(`rewritten: ${summary.pagesRewritten} page(s)`);
  if (summary.failed > 0) console.log(`failed:    ${summary.failed} page(s)`);
  if (summary.actingUserEmail) console.log(`author:    ${summary.actingUserEmail}`);
  console.log(`elapsed:   ${formatElapsed(elapsedMs)}`);

  if (summary.interrupted) {
    console.log('');
    console.log('Interrupted by SIGINT before completion — re-run to finish.');
    return;
  }
  console.log('');
  console.log("Replacement complete. Run 'crowi-admin rebuild search' to refresh the search index (page rendering is already up to date).");
}

/** Elapsed-duration formatter (mirrors watcher-backfill / rebuild). */
function formatElapsed(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const totalSeconds = Math.round(ms / 1000);
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}m${seconds.toString().padStart(2, '0')}s`;
}
