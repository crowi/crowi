import type { Command } from 'commander';

import { editInEditor, resolveEditor } from '../lib/editor';
import { CliError, EXIT } from '../lib/http';
import { info, render } from '../lib/output';
import { normalisePath } from '../lib/page-ref';
import { fetchCurrentPage, isRevisionConflict, postPage, putPage } from '../lib/page-write';
import { requireProfile } from './_shared';

/**
 * `crowi edit <path>` — interactively edit a page in `$EDITOR`.
 *
 * Flow:
 *   1. GET the page (capturing body + revision_id). A 404 means the target
 *      does not exist yet → start from an empty buffer and create-on-save.
 *   2. Open the body in `$EDITOR` (or `--editor` / `$VISUAL`).
 *   3. On editor exit: if the content is unchanged, no-op. Otherwise an
 *      existing page is saved with `PUT` + its `revision_id` (optimistic
 *      lock); a new page is saved with `POST`.
 *
 * On a 409 conflict (the page moved on the server while editing) the save
 * ABORTS by default with a clear message; `--force` re-fetches the current
 * revision and overwrites. Never silently clobbers.
 */
export function registerEdit(program: Command): void {
  program
    .command('edit <path>')
    .description('Edit a page interactively in $EDITOR (creates it if missing)')
    .option('--editor <bin>', 'editor to open (overrides $VISUAL / $EDITOR)')
    .option('--force', 'on a revision conflict, re-fetch and overwrite instead of aborting')
    .action(async (path: string, options: { editor?: string; force?: boolean }, command: Command) => {
      const { profile, globals } = requireProfile(command);

      const current = await fetchCurrentPage(profile, path);
      const original = current?.body ?? '';
      const isNew = current === null || current.pageId === undefined;

      if (isNew) {
        info(`Page ${normalisePath(path)} does not exist — it will be created on save.`, globals);
      }

      const edited = await editInEditor(original, resolveEditor(options.editor));

      if (edited === original) {
        render({ path: current?.path ?? normalisePath(path), changed: false }, () => 'No changes — page left untouched.', globals);
        return;
      }

      // New page (create-on-save). An empty buffer aborts so an accidental
      // open never creates a blank page.
      if (isNew) {
        if (edited.trim() === '') {
          throw new CliError('empty body — page not created', { exitCode: EXIT.INVALID });
        }
        const result = await postPage(profile, { path: normalisePath(path), body: edited });
        render({ path: result.path, pageId: result.pageId, revisionId: result.revisionId }, () => `Created ${result.path ?? normalisePath(path)}`, globals);
        return;
      }

      // Existing page: PUT with the revision_id read in step 1.
      const pageId = current?.pageId;
      if (pageId === undefined) {
        throw new CliError(`page ${normalisePath(path)} has no id — cannot update`, { exitCode: EXIT.GENERAL });
      }

      try {
        const result = await putPage(profile, { pageId, body: edited, revisionId: current?.revisionId });
        render({ path: result.path, pageId: result.pageId, revisionId: result.revisionId }, () => `Updated ${result.path ?? normalisePath(path)}`, globals);
      } catch (err) {
        if (!isRevisionConflict(err)) {
          throw err;
        }
        if (!options.force) {
          throw new CliError(
            `revision conflict: ${normalisePath(path)} changed on the server while you were editing. Your edits were NOT saved. Re-run with --force to overwrite, or re-edit to merge.`,
            { exitCode: EXIT.CONFLICT },
          );
        }
        info('Revision conflict — re-fetching latest revision and overwriting (--force)…', globals);
        const latest = await fetchCurrentPage(profile, path);
        if (latest === null || latest.pageId === undefined) {
          throw new CliError(`page ${normalisePath(path)} disappeared during --force retry`, { exitCode: EXIT.NOT_FOUND });
        }
        const result = await putPage(profile, { pageId: latest.pageId, body: edited, revisionId: latest.revisionId });
        render(
          { path: result.path, pageId: result.pageId, revisionId: result.revisionId },
          () => `Updated ${result.path ?? normalisePath(path)} (forced)`,
          globals,
        );
      }
    });
}
