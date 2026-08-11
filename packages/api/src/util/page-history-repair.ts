import type Crowi from 'src/crowi';
import { redactErrorReason, repairPendingEntries, scanUnsequencedRevisions } from 'src/service/page-history/repair';

/**
 * Re-exported so `@crowi/admin-cli`'s `page-history repair` command (which
 * `require()`s this compiled module at runtime — see
 * `commands/page-history-repair.ts`'s `loadApi()`) can apply the same AC-8b
 * redaction to the two error paths that escape every service-level per-page
 * `try`/`catch` inside `repairPendingEntries`/`scanUnsequencedRevisions`:
 * Crowi initialization failure and a structural failure inside
 * {@link runPageHistoryRepair} itself.
 */
export { redactErrorReason };

/**
 * RFC-0021 §6.4/§13.2a (`feature-page-history-phase1-model`, Phase 1) — the
 * operator entry point `service/page-history/repair.ts`'s implementation
 * map calls for ("運用者が起動できる入口も用意する"). `repairPendingEntries` /
 * `scanUnsequencedRevisions` themselves stay boot-hook-free and scheduler-
 * free (the spec's flow section: "テストが唯一の実行者であり、それが意図した状態である" —
 * Phase 1 ships no writer, so in normal operation there is nothing for
 * either scan to find); this module is only the thin, explicitly-invoked
 * wrapper an operator runs by hand via `crowi-admin page-history repair`
 * (`@crowi/admin-cli`'s `commands/page-history-repair.ts`), mirroring
 * `runWatcherBackfill`'s (`util/watcher-backfill.ts`) role for that
 * command.
 *
 * `--outbox` (default) and `--scan` are independent flags, not a single
 * "repair everything" default, because they carry very different blast
 * radii: outbox repair (`repairPendingEntries`) only ever finishes work a
 * crashed writer already started (Phase 1 has none, so it is a safe no-op
 * to always run) — the unsequenced-Revision scan
 * (`scanUnsequencedRevisions`) would, in Phase 1, mass-assign a sequence to
 * EVERY Revision on EVERY `ready` Page, because no writer populates
 * `historySequence` yet. That is Phase 2's real backfill migration's job
 * (RFC §13.2), not something this operator tool should do implicitly.
 *
 * The `repaired`/`blocked`/`failed` detail arrays (codex review attempt 3,
 * AC-7/8: "operator report truncated" — a prior version reduced these to
 * counts only) are preserved here in full, with every id serialized to a
 * string, so the CLI wrapper (`formatRepairReport`,
 * `@crowi/admin-cli/commands/page-history-repair.ts`) can print exactly
 * which Page/Revision needs attention instead of only how many. Every
 * `{page, revision, sequence, reason}` field `service/page-history/repair.ts`
 * itself reports (codex review attempt 3, AC-7/8: "detail arrays do not
 * preserve the required {page, revision, sequence, reason} information
 * end-to-end") is threaded through here unchanged — `repaired.reason`,
 * `blocked.revisionId`, and `failed.revisionId`/`failed.sequence` are not
 * dropped on the way from the service's `ObjectId`-typed result to this
 * string-serialized summary.
 */
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

export interface RunPageHistoryRepairOptions {
  outbox?: boolean;
  scan?: boolean;
  /** Bounds Pages loaded per round-trip for whichever scan(s) run — threaded to `repair.ts`'s `RepairScanOptions`. */
  batchSize?: number;
  /** Resume a previous (possibly interrupted) run — only Pages with `_id > resumeAfterId` are visited, for whichever scan(s) run. */
  resumeAfterId?: string;
}

export async function runPageHistoryRepair(crowi: Crowi, opts: RunPageHistoryRepairOptions = {}): Promise<PageHistoryRepairSummary> {
  // Neither flag given -> outbox repair only (the always-safe default).
  const runOutbox = opts.outbox === true || opts.scan !== true;
  const runScan = opts.scan === true;
  const scanOptions = { batchSize: opts.batchSize, resumeAfterId: opts.resumeAfterId };

  const summary: PageHistoryRepairSummary = {};

  if (runOutbox) {
    summary.outbox = await repairPendingEntries(crowi, scanOptions);
  }

  if (runScan) {
    const result = await scanUnsequencedRevisions(crowi, scanOptions);
    summary.unsequencedRevisions = {
      scannedPages: result.scannedPages,
      repaired: result.repaired.map((r) => ({
        pageId: String(r.pageId),
        revisionId: String(r.revisionId),
        assignedSequence: r.assignedSequence,
        reason: r.reason,
      })),
      blocked: result.blocked.map((b) => ({
        pageId: String(b.pageId),
        revisionId: b.revisionId != null ? String(b.revisionId) : undefined,
        duplicateSequence: b.duplicateSequence,
        reason: b.reason,
      })),
      failed: result.failed,
      lastPageId: result.lastPageId,
    };
  }

  return summary;
}
