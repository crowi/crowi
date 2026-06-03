import type { Command } from 'commander';

/**
 * RFC-0008 §8.5 — the `crowi-admin rebuild <target>` namespace.
 *
 * Operational rebuilds of derived data — version-independent, runnable any
 * time, any number of times (no pending/applied concept). All targets share
 * the framework runner's `--dry-run` / progress conventions (§4.3).
 *
 * Phase 1 ships only the dispatcher skeleton: each target is registered so
 * `crowi-admin rebuild --help` lists the full surface, but the actual task
 * wiring is filled in by Phase 4:
 *   - `rebuild search`        ← migrate from `search rebuild` (existing impl)
 *   - `rebuild storage copy`  ← migrate from `storage copy` (existing impl)
 *   - `rebuild renderer`      ← new (util/rebuild-renderer.ts skeleton, TODO)
 *   - `rebuild backlink`      ← new (util/rebuild-backlink.ts skeleton, TODO)
 *
 * Until then the targets print a not-yet-available notice and exit non-zero
 * so an operator scripting against them gets a clear signal rather than a
 * silent success.
 */

const NOT_YET = (target: string): void => {
  console.error(`crowi-admin: 'rebuild ${target}' is not available yet (RFC-0008 Phase 4). Use the existing command form for now.`);
  process.exit(2);
};

export function registerRebuild(program: Command): void {
  const rebuild = program.command('rebuild').description('Operational rebuilds of derived data (renderer / search / backlink / storage copy).');

  rebuild
    .command('renderer')
    .description('Regenerate cached rendered HTML for pages. (Phase 4)')
    .option('--only-stale', 'Only re-render pages whose cache is stale.', false)
    .option('--dry-run', 'Report what would be rebuilt without writing.', false)
    .action(() => NOT_YET('renderer'));

  rebuild
    .command('search')
    .description("Rebuild the search index from scratch using the active driver's rebuild(). (Phase 4)")
    .option('--dry-run', 'Report what would be rebuilt without writing.', false)
    .action(() => NOT_YET('search'));

  rebuild
    .command('backlink')
    .description('Rebuild the backlink index across all pages. (Phase 4)')
    .option('--dry-run', 'Report what would be rebuilt without writing.', false)
    .action(() => NOT_YET('backlink'));

  const storage = rebuild.command('storage').description('Storage driver rebuilds.');
  storage
    .command('copy')
    .description('Copy every stored object from one driver to another. (Phase 4)')
    .option('--from <name>', 'Source storage driver name.')
    .option('--to <name>', 'Destination storage driver name.')
    .option('--dry-run', 'List candidate keys without copying anything.', false)
    .action(() => NOT_YET('storage copy'));
}
