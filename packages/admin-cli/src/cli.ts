import { Command } from 'commander';
import { registerMigrate } from './commands/migrate';
import { registerRebuild } from './commands/rebuild';
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
  // `watcher backfill` (idempotent WATCH-row backfill) landed on main as a
  // standalone command; kept as-is here. Could fold into the framework as a
  // `rebuild` / `migrate` task later (see TODO backlog).
  registerWatcherBackfill(program);

  return program;
}
