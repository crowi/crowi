import type { Command } from 'commander';

import { authedFetch, CliError, EXIT } from '../lib/http';
import { info, render } from '../lib/output';
import { normalisePath } from '../lib/page-ref';
import { fetchCurrentPage, isRevisionConflict } from '../lib/page-write';
import { requireProfile } from './_shared';

/** Lenient `DELETE /api/pages` response — the deleted/trashed page. */
interface DeletePageResponse {
  page?: { _id?: string; path?: string };
}

/**
 * The `DELETE /api/pages` request body (DeletePageRequestSchema, inline in
 * contracts/page.ts and therefore not exported). The shape is trivial and
 * `page_id` is sourced from a just-fetched page, so it is built directly here
 * rather than pulling zod into the CLI just to re-validate a server-sourced
 * id.
 */
interface DeletePageBody {
  page_id: string;
  revision_id?: string;
  completely?: boolean;
}

/**
 * `crowi rm <path>` — delete a page via `DELETE /api/pages`
 * (`pages:write`). Soft-deletes to the trash by default (recoverable with
 * `crowi` restore); `--completely` hard-deletes irreversibly.
 *
 * The page's current `revision_id` is fetched first and sent for the
 * optimistic-lock check; a 409 means the page changed since it was read and
 * the delete ABORTS unless `--force` is given (re-fetch + retry).
 */
export function registerRm(program: Command): void {
  program
    .command('rm <path>')
    .description('Delete a page (soft-delete to trash by default; --completely to purge)')
    .option('--completely', 'permanently delete instead of moving to trash')
    .option('--force', 'on a revision conflict, re-fetch and delete instead of aborting')
    .action(async (path: string, options: { completely?: boolean; force?: boolean }, command: Command) => {
      const { profile, globals } = requireProfile(command);

      const current = await fetchCurrentPage(profile, path);
      if (current === null || current.pageId === undefined) {
        throw new CliError(`page ${normalisePath(path)} not found`, { exitCode: EXIT.NOT_FOUND });
      }

      const deletePage = async (pageId: string, revisionId?: string): Promise<DeletePageResponse> => {
        const body: DeletePageBody = { page_id: pageId, revision_id: revisionId, completely: options.completely === true };
        return authedFetch<DeletePageResponse>(profile, 'DELETE', '/pages', { json: body });
      };

      try {
        const result = await deletePage(current.pageId, current.revisionId);
        const verb = options.completely ? 'Permanently deleted' : 'Moved to trash';
        render(
          { path: current.path ?? normalisePath(path), trashPath: result.page?.path, completely: options.completely === true },
          () => `${verb} ${current.path ?? normalisePath(path)}`,
          globals,
        );
      } catch (err) {
        if (!isRevisionConflict(err)) {
          throw err;
        }
        if (!options.force) {
          throw new CliError(`revision conflict: ${normalisePath(path)} changed on the server since it was read. Re-run with --force to delete anyway.`, {
            exitCode: EXIT.CONFLICT,
          });
        }
        info('Revision conflict — re-fetching latest revision and deleting (--force)…', globals);
        const latest = await fetchCurrentPage(profile, path);
        if (latest === null || latest.pageId === undefined) {
          // Already gone — treat as success (idempotent delete).
          render({ path: normalisePath(path), alreadyGone: true }, () => `${normalisePath(path)} is already gone.`, globals);
          return;
        }
        const result = await deletePage(latest.pageId, latest.revisionId);
        const verb = options.completely ? 'Permanently deleted' : 'Moved to trash';
        render(
          { path: latest.path ?? normalisePath(path), trashPath: result.page?.path, completely: options.completely === true },
          () => `${verb} ${latest.path ?? normalisePath(path)} (forced)`,
          globals,
        );
      }
    });
}
