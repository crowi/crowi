import { Command } from 'commander';
import { registerMigrate } from './commands/migrate';
import { registerPageHistoryRepair } from './commands/page-history-repair';
import { registerRebuild } from './commands/rebuild';
import { registerReplace } from './commands/replace';
import { registerWatcherBackfill } from './commands/watcher-backfill';

/**
 * Build the root commander program. Exported so the bin entry point
 * (`bin.ts`) can call `parseAsync` on it, and so future test harnesses
 * can drive the CLI without spawning a child process.
 *
 * Subcommands are registered via small per-command helpers
 * (`registerXxx(program)`) so each command keeps its own arg / option
 * declarations next to its implementation.
 */
export function createProgram(): Command {
  // feature-admin-cli-quiet-output: admin-cli talks directly to MongoDB /
  // storage drivers, and transitive deps (e.g. `url.parse()`, DEP0169) still
  // emit Node's own DeprecationWarning — operator-irrelevant noise on every
  // invocation, dev and prod alike. Equivalent to `--no-deprecation`, set
  // programmatically here (not via a `node` flag) so it applies regardless of
  // how the CLI is invoked (`pnpm migrate ...`, `crowi-admin ...`, or the
  // built `dist/bin.js` directly, as prod does).
  process.noDeprecation = true;

  const program = new Command();
  program
    .name('crowi-admin')
    .description('Operator-side admin CLI for Crowi 2.0. Talks directly to MongoDB; intended for use inside the server (ssh / kubectl exec).')
    .version('0.1.0-dev');

  // RFC-0008: the unified migration framework namespaces. The wikilink
  // migration lives under `migrate apply --id wikilink-format` (phase 3); the
  // legacy top-level `storage copy` / `search rebuild` forms are gone (phase
  // 4) — their tasks now ride the shared runner under `rebuild storage copy` /
  // `rebuild search`. No compatibility aliases (CHANGELOG / upgrade guide).
  registerMigrate(program);
  registerRebuild(program);
  // `replace url` (literal in-body URL/host swap for v1→v2 domain changes).
  // Not a versioned migration (arbitrary from/to, re-runnable) nor a derived-
  // data rebuild (it mutates revision bodies) — its own namespace.
  registerReplace(program);
  // `watcher backfill` (idempotent WATCH-row backfill) landed on main as a
  // standalone command; kept as-is here. Could fold into the framework as a
  // `rebuild` / `migrate` task later (see TODO backlog).
  registerWatcherBackfill(program);
  // RFC-0021 Phase 1 (feature-page-history-phase1-model) — the operator
  // entry point for page-history outbox/sequence repair. Same standalone
  // shape as `watcher backfill`, not a `rebuild`/`migrate` task (it repairs
  // Phase-1 bookkeeping state, not derived data).
  registerPageHistoryRepair(program);

  return program;
}
