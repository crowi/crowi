import path from 'node:path';
import dotenv from 'dotenv';
import type { Command } from 'commander';
import { parsePositiveIntOption } from './rebuild';

/**
 * Resolve @crowi/api's installed location relative to the caller's CWD
 * (= the runner directory) and load the bits we need, the same way
 * `watcher-backfill.ts` does (manual `require` so `@crowi/api`'s `app.ts`
 * auto-boot doesn't fire). Returns `null` when the package isn't found so
 * the caller can print a friendly error.
 */
function loadApi(): { Crowi: ApiCrowiCtor; runPageHistoryRepair: RunPageHistoryRepair; redactErrorReason: (err: unknown) => string } | null {
  let apiPkgPath: string;
  try {
    apiPkgPath = require.resolve('@crowi/api/package.json', { paths: [process.cwd(), __dirname] });
  } catch {
    return null;
  }
  const distDir = path.join(path.dirname(apiPkgPath), 'dist');
  const crowiModule = require(path.join(distDir, 'crowi')) as { default: ApiCrowiCtor };
  const repairModule = require(path.join(distDir, 'util', 'page-history-repair')) as {
    runPageHistoryRepair: RunPageHistoryRepair;
    redactErrorReason: (err: unknown) => string;
  };
  return { Crowi: crowiModule.default, runPageHistoryRepair: repairModule.runPageHistoryRepair, redactErrorReason: repairModule.redactErrorReason };
}

interface ApiCrowi {
  initForCli(): Promise<void>;
  teardownForCli(): Promise<void>;
}
interface ApiCrowiCtor {
  new (rootDir: string, env: NodeJS.ProcessEnv): ApiCrowi;
}

/** Mirrors `@crowi/api`'s `util/page-history-repair.ts` `PageHistoryRepairSummary` — kept structural since admin-cli loads api's compiled `dist/` at runtime instead of importing it directly. */
export interface PageHistoryRepairSummary {
  outbox?: {
    scannedPages: number;
    repairedPageIds: string[];
    failed: { pageId: string; revisionId?: string; sequence?: number; reason: string }[];
    lastPageId: string | null;
  };
  unsequencedRevisions?: {
    scannedPages: number;
    repaired: { pageId: string; revisionId: string; assignedSequence: number; reason: string }[];
    blocked: { pageId: string; revisionId?: string; duplicateSequence: number; reason: string }[];
    failed: { pageId: string; revisionId?: string; sequence?: number; reason: string }[];
    lastPageId: string | null;
  };
}
type RunPageHistoryRepair = (
  crowi: ApiCrowi,
  opts?: { outbox?: boolean; scan?: boolean; batchSize?: number; resumeAfterId?: string },
) => Promise<PageHistoryRepairSummary>;

export interface RepairReportResult {
  lines: string[];
  exitCode: number;
}

/**
 * Pure formatter for the `action` callback's two top-level catch blocks
 * below (Crowi init failure / the repair call itself throwing) — AC-8b
 * (codex review attempt 2, round 6: "prints raw initialization/repair error
 * messages and stacks ... escaping the service-level per-page catches").
 * Neither escaping error is guaranteed free of a raw Mongoose validation/
 * cast/duplicate-key message (Crowi's boot sequence touches Config documents
 * that can hold sensitive values, and `runPageHistoryRepair`'s own structural
 * failures — e.g. the batch cursor's `Page.find()` itself throwing — are not
 * wrapped by any of `repairPendingEntries`/`scanUnsequencedRevisions`'s
 * per-page `try`/`catch`), so both route through the injected `redact`
 * function (`@crowi/api`'s `redactErrorReason`, loaded via `loadApi()`)
 * instead of ever printing `err.message`/`err.stack` verbatim. Extracted as
 * a pure function (no console I/O, `redact` injected rather than imported)
 * so the wiring is unit-testable without this file's CLI boot ceremony or a
 * `mongoose` dependency in this package — mirrors `formatRepairReport`'s own
 * pattern.
 */
export function formatFatalErrorLine(prefix: string, err: unknown, redact: (err: unknown) => string): string {
  return `${prefix}${redact(err)}`;
}

/**
 * Renders a `failed` entry's optional `revisionId`/`sequence` (codex review
 * attempt 3, AC-7/8: "`failed` lacks revision/sequence" — the api-side
 * `OutboxRepairFailure` now carries them when the failure is tied to a
 * specific Revision) as a printable suffix, e.g. `(revision 6519..., sequence
 * 4)` — empty when neither is present, so a page-level-only failure (e.g. the
 * initial Revision/PageHistoryEvent lookup) prints exactly as before.
 */
function formatDetailSuffix(detail: { revisionId?: string; sequence?: number }): string {
  const parts: string[] = [];
  if (detail.revisionId != null) parts.push(`revision ${detail.revisionId}`);
  if (detail.sequence != null) parts.push(`sequence ${detail.sequence}`);
  return parts.length > 0 ? ` (${parts.join(', ')})` : '';
}

/**
 * Pure summary -> printable-report + exit-code mapping (codex review attempt
 * 3, AC-7/8: "operator report truncated ... must preserve details in CLI
 * output; add CLI test to lock report content and exit codes"). A prior
 * version reduced `unsequencedRevisions.repaired`/`.blocked` to counts only
 * before printing, so an operator could see THAT something needed
 * investigation but not WHICH Page/Revision. Extracted as a pure function
 * (no `process.exit`/console I/O) so it's unit-testable without the boot
 * ceremony the `action` below performs — mirrors `rebuild.ts`'s
 * `rebuildExitCode` pattern.
 *
 * Exit code follows this repo's ALREADY-DOCUMENTED admin-cli convention
 * (`apps/crowi-site/content/docs/{ja,en}/operations/storage.mdx`'s `storage
 * copy` / `rebuild attachment-display-derivatives` tables, and
 * `rebuild.ts`'s `rebuildExitCode`, which this file otherwise mirrors
 * throughout):
 *
 * | code | meaning |
 * | --- | --- |
 * | `0` | success — every scan that ran found nothing needing attention |
 * | `1` | fatal — init/lookup failed, or the repair call itself threw (see the `action` below; never reaches this function) |
 * | `2` | partial — the run completed but found `>=1` `failed`/`blocked` entry (operator should investigate, then re-run) |
 *
 * (Codex review attempt 4 asserted the inverse — 1 for blockages, 2 reserved
 * for CLI errors — citing no source; there is no such requirement in this
 * feature's spec or RFC-0021 (both grepped clean for "exit"/"終了コード"), and
 * the claim is also internally inconsistent: it names only the 3 lines below
 * to flip, which would leave `2` unreachable in this whole file and collide
 * "blocked" with "fatal" on `1` — the opposite of the SAME distinction the
 * finding's own "2 for CLI errors only" is trying to preserve. Kept at `2`
 * to match the one convention this command's sibling commands and the
 * published operator docs actually document; see this feature's task
 * history for the full evidence trail.)
 */
export function formatRepairReport(summary: PageHistoryRepairSummary): RepairReportResult {
  const lines: string[] = [];
  let exitCode = 0;

  if (summary.outbox) {
    const { scannedPages, repairedPageIds, failed, lastPageId } = summary.outbox;
    lines.push(`outbox: scanned=${scannedPages} repaired=${repairedPageIds.length} failed=${failed.length} lastPageId=${lastPageId ?? '(none)'}`);
    if (repairedPageIds.length > 0) {
      lines.push('  repaired pages:');
      for (const pageId of repairedPageIds) lines.push(`    ${pageId}`);
    }
    if (failed.length > 0) {
      lines.push('  outbox failures (needs manual investigation):');
      for (const f of failed) lines.push(`    page ${f.pageId}${formatDetailSuffix(f)}: ${f.reason}`);
      exitCode = 2;
    }
  }

  if (summary.unsequencedRevisions) {
    const { scannedPages, repaired, blocked, failed, lastPageId } = summary.unsequencedRevisions;
    lines.push(
      `unsequenced-revision scan: scanned=${scannedPages} repaired=${repaired.length} blocked=${blocked.length} failed=${failed.length} lastPageId=${lastPageId ?? '(none)'}`,
    );
    if (repaired.length > 0) {
      lines.push('  assigned sequences:');
      for (const r of repaired) lines.push(`    page ${r.pageId} revision ${r.revisionId}: sequence ${r.assignedSequence} — ${r.reason}`);
    }
    if (blocked.length > 0) {
      lines.push('  blocked pages (needs manual investigation, NOT auto-repaired):');
      for (const b of blocked) lines.push(`    page ${b.pageId}${formatDetailSuffix(b)}: duplicateSequence=${b.duplicateSequence} — ${b.reason}`);
      exitCode = 2;
    }
    if (failed.length > 0) {
      lines.push('  scan failures (needs manual investigation):');
      for (const f of failed) lines.push(`    page ${f.pageId}${formatDetailSuffix(f)}: ${f.reason}`);
      exitCode = 2;
    }
  }

  return { lines, exitCode };
}

/**
 * RFC-0021 §6.4/§13.2a (`feature-page-history-phase1-model`, Phase 1) —
 * `page-history repair` subcommand, the operator entry point the spec's
 * `service/page-history/repair.ts` implementation map calls for
 * ("運用者が起動できる入口も用意する"). Mirrors `watcher backfill`'s structure.
 *
 * Invocation:
 *   crowi-admin page-history repair [--outbox] [--scan] [--batch-size <n>] [--resume-after <pageId>]
 *
 * `--outbox` (default when neither flag is given): drains any Page whose
 * `pendingHistoryEntry` outbox slot is still occupied because a prior
 * writer crashed between materializing its target and clearing the marker.
 * Idempotent, always safe to run — Phase 1 ships no writer that populates
 * the outbox, so in normal operation this finds nothing.
 *
 * `--scan`: walks every `ready` Page for a Revision missing
 * `historySequence` and assigns one (oldest first), or blocks the Page for
 * manual repair if it finds a duplicate/inconsistent sequence instead. NOT
 * the default and NOT auto-run at boot — Phase 1 populates `ready` from
 * new-Page creation only, so unlike outbox repair this is a real, visible
 * mutation an operator should choose to run, not one this CLI defaults to.
 *
 * `--batch-size` / `--resume-after`: both scans page through their match in
 * bounded, `_id`-sorted batches (`service/page-history/repair.ts`'s
 * `RepairScanOptions`) instead of loading every candidate Page into memory
 * at once. `--resume-after` lets an operator continue a run that was killed
 * mid-scan from just past the last Page a prior invocation reported via
 * `lastPageId`.
 */
export function registerPageHistoryRepair(program: Command): void {
  const pageHistory = program.command('page-history').description('Page metadata history (RFC-0021) maintenance utilities.');

  pageHistory
    .command('repair')
    .description(
      "Repair page-history outbox/sequence state. --outbox (default) drains any crashed writer's leftover pendingHistoryEntry. --scan assigns historySequence to unsequenced Revisions on ready Pages (not run by default).",
    )
    .option('--outbox', 'Run the outbox (pendingHistoryEntry) repair scan.', false)
    .option('--scan', 'Run the unsequenced-Revision sequence-assignment scan.', false)
    .option('--batch-size <n>', 'Bound how many Pages are loaded into memory per round-trip.', '200')
    .option('--resume-after <pageId>', 'Resume a previous run: only Pages with _id greater than this value are visited.')
    .action(async (opts: { outbox?: boolean; scan?: boolean; batchSize: string; resumeAfter?: string }) => {
      // Load .env so MONGO_URI / CROWI_ENCRYPTION_KEY flow into Crowi the
      // same way `app.ts` does at boot. Silent if no .env present.
      dotenv.config();

      let batchSize: number;
      try {
        batchSize = parsePositiveIntOption(opts.batchSize, '--batch-size');
      } catch (err) {
        console.error(`crowi-admin: ${(err as Error).message}`);
        process.exit(1);
      }

      const api = loadApi();
      if (!api) {
        console.error('crowi-admin: could not locate @crowi/api. Run from a directory that has @crowi/api installed (e.g. the runner package).');
        process.exit(1);
      }

      const crowi = new api.Crowi(process.cwd(), process.env);
      const runOutbox = Boolean(opts.outbox) || !opts.scan;
      const runScan = Boolean(opts.scan);
      console.log(`[crowi-admin] page-history repair: starting (outbox=${runOutbox}, scan=${runScan}, batchSize=${batchSize})`);

      try {
        await crowi.initForCli();
      } catch (err) {
        console.error(formatFatalErrorLine('crowi-admin: failed to initialise Crowi: ', err, api.redactErrorReason));
        await crowi.teardownForCli().catch(() => undefined);
        process.exit(1);
      }

      let exitCode = 0;
      try {
        const startedAt = Date.now();
        const summary = await api.runPageHistoryRepair(crowi, { outbox: runOutbox, scan: runScan, batchSize, resumeAfterId: opts.resumeAfter });
        const elapsedMs = Date.now() - startedAt;
        console.log('');
        console.log('--- summary ---');
        const report = formatRepairReport(summary);
        for (const line of report.lines) console.log(line);
        console.log(`elapsed: ${formatElapsed(elapsedMs)}`);
        console.log('');
        console.log(report.exitCode === 0 ? 'Repair complete.' : 'Repair complete with pages blocked/failed for manual investigation.');
        exitCode = report.exitCode;
      } catch (err) {
        console.error('crowi-admin: page-history repair failed.');
        console.error(formatFatalErrorLine('  reason: ', err, api.redactErrorReason));
        exitCode = 1;
      } finally {
        await crowi.teardownForCli().catch(() => undefined);
      }
      process.exit(exitCode);
    });
}

/** Elapsed-duration formatter (mirrors `watcher-backfill.ts`'s). */
function formatElapsed(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const totalSeconds = Math.round(ms / 1000);
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}m${seconds.toString().padStart(2, '0')}s`;
}
