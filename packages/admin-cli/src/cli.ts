import { Command } from 'commander';
import { registerStorageCopy } from './commands/storage-copy';

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

  registerStorageCopy(program);

  return program;
}
