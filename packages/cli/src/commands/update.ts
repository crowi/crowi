import type { Command } from 'commander';

import { resolveBody } from '../lib/body-input';
import { CliError, EXIT } from '../lib/http';
import { info, render } from '../lib/output';
import { normalisePath } from '../lib/page-ref';
import { fetchCurrentPage, isRevisionConflict, putPage } from '../lib/page-write';
import { requireProfile } from './_shared';

/**
 * `crowi update <path>` — non-interactive, revision-locked body replace via
 * `PUT /api/pages` (`pages:write`). The new body comes from one of
 * `--message` / `--file` / `--stdin` (exactly one required — there is no
 * editor fallback; use `crowi edit` for that). The page must already exist;
 * its current `revision_id` is fetched first and sent for the optimistic-lock
 * check. On a 409 conflict the update ABORTS by default; `--force` re-fetches
 * the current revision and overwrites (never silently clobbers).
 */
export function registerUpdate(program: Command): void {
  program
    .command('update <path>')
    .description('Replace a page body non-interactively (--message / --file / --stdin)')
    .option('-m, --message <text>', 'new page body supplied literally')
    .option('-f, --file <path>', 'read the new page body from a local file')
    .option('--stdin', 'read the new page body from standard input')
    .option('--force', 'on a revision conflict, re-fetch and overwrite instead of aborting')
    .action(async (path: string, options: { message?: string; file?: string; stdin?: boolean; force?: boolean }, command: Command) => {
      const { profile, globals } = requireProfile(command);

      const body = await resolveBody(options);
      if (body === undefined) {
        throw new CliError('a body is required — pass one of --message, --file, or --stdin', { exitCode: EXIT.INVALID });
      }

      const current = await fetchCurrentPage(profile, path);
      if (current === null || current.pageId === undefined) {
        throw new CliError(`page ${normalisePath(path)} not found — use \`crowi create\` to make a new page`, { exitCode: EXIT.NOT_FOUND });
      }

      try {
        const result = await putPage(profile, { pageId: current.pageId, body, revisionId: current.revisionId });
        render({ path: result.path, pageId: result.pageId, revisionId: result.revisionId }, () => `Updated ${result.path ?? normalisePath(path)}`, globals);
      } catch (err) {
        if (!isRevisionConflict(err)) {
          throw err;
        }
        if (!options.force) {
          throw new CliError(`revision conflict: ${normalisePath(path)} changed on the server since it was read. Re-run with --force to overwrite.`, {
            exitCode: EXIT.CONFLICT,
          });
        }
        // --force: re-read the latest revision_id and overwrite.
        info('Revision conflict — re-fetching latest revision and overwriting (--force)…', globals);
        const latest = await fetchCurrentPage(profile, path);
        if (latest === null || latest.pageId === undefined) {
          throw new CliError(`page ${normalisePath(path)} disappeared during --force retry`, { exitCode: EXIT.NOT_FOUND });
        }
        const result = await putPage(profile, { pageId: latest.pageId, body, revisionId: latest.revisionId });
        render(
          { path: result.path, pageId: result.pageId, revisionId: result.revisionId },
          () => `Updated ${result.path ?? normalisePath(path)} (forced)`,
          globals,
        );
      }
    });
}
