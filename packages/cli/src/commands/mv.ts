import { RenamePageRequestSchema, RenameSubtreeRequestSchema } from '@crowi/api-contract';
import type { Command } from 'commander';

import { authedFetch, CliError, EXIT } from '../lib/http';
import { info, render } from '../lib/output';
import { isObjectId, normalisePath } from '../lib/page-ref';
import { fetchCurrentPage } from '../lib/page-write';
import { requireProfile, rethrowNewerEndpointHint } from './_shared';

/** Lenient `POST /api/v2/pages/rename` response (RenamePageResponseSchema). */
interface RenamePageResponse {
  page?: { _id?: string; path?: string };
  renamed_count?: number;
}

/** Lenient `POST /api/v2/pages/rename-subtree` response. */
interface RenameSubtreeResponse {
  renamed_count?: number;
}

/**
 * `crowi mv <old> <new>` — move/rename a page (and optionally its subtree)
 * via `POST /api/v2/pages/rename` (`pages:write`).
 *
 * The source may be a `<path-or-id>`. When it resolves to a real page
 * document the single-page rename endpoint is used (with `--recursive` to
 * carry the descendant subtree along). When the source is a *path* that has
 * no page document of its own (a portal-less folder) the rename-subtree
 * endpoint is used instead, keyed on the path.
 *
 * `--no-redirect` suppresses the leave-behind redirect (a redirect is left
 * by default so existing links keep working).
 */
export function registerMv(program: Command): void {
  program
    .command('mv <old> <new>')
    .description('Move/rename a page (or a portal-less folder) to a new path')
    .option('--no-redirect', 'do not leave a redirect at the old path')
    .option('--recursive', 'also move the descendant subtree (single-page rename only)')
    .action(async (oldRef: string, newPath: string, options: { redirect?: boolean; recursive?: boolean }, command: Command) => {
      const { profile, globals } = requireProfile(command);

      const destination = normalisePath(newPath);
      // commander sets `redirect` to false when --no-redirect is passed; a
      // redirect is left by default.
      const createRedirect = options.redirect !== false;

      const current = await fetchCurrentPage(profile, oldRef);

      // The source resolves to a real page document → single-page rename
      // (optionally carrying the subtree with --recursive).
      if (current !== null && current.pageId !== undefined) {
        const parsed = RenamePageRequestSchema.safeParse({
          page_id: current.pageId,
          new_path: destination,
          revision_id: current.revisionId,
          create_redirect: createRedirect,
          include_descendants: options.recursive === true,
        });
        if (!parsed.success) {
          throw new CliError(`invalid rename: ${parsed.error.issues.map((i) => i.message).join('; ')}`, { exitCode: EXIT.INVALID });
        }

        const result = await authedFetch<RenamePageResponse>(profile, 'POST', '/pages/rename', { json: parsed.data });
        render(
          { from: current.path, to: result.page?.path ?? destination, renamedCount: result.renamed_count },
          () =>
            `Moved ${current.path ?? oldRef} → ${result.page?.path ?? destination}${result.renamed_count && result.renamed_count > 1 ? ` (${result.renamed_count} pages)` : ''}`,
          globals,
        );
        return;
      }

      // No page document. If the source was given as a bare ObjectId we have
      // nothing to fall back to; otherwise treat it as a portal-less folder
      // and use the path-keyed subtree rename.
      if (isObjectId(oldRef)) {
        throw new CliError(`page ${oldRef} not found`, { exitCode: EXIT.NOT_FOUND });
      }

      info(`${normalisePath(oldRef)} has no page of its own — moving it as a folder (subtree)…`, globals);
      const parsed = RenameSubtreeRequestSchema.safeParse({
        old_path: normalisePath(oldRef),
        new_path: destination,
        create_redirect: createRedirect,
      });
      if (!parsed.success) {
        throw new CliError(`invalid rename: ${parsed.error.issues.map((i) => i.message).join('; ')}`, { exitCode: EXIT.INVALID });
      }

      // `POST /pages/rename-subtree` is above the v2 floor: an older instance
      // may lack the route entirely. A 404 there is ambiguous, so degrade it
      // to a clear "needs a newer Crowi" hint rather than a bare not-found.
      const result = await authedFetch<RenameSubtreeResponse>(profile, 'POST', '/pages/rename-subtree', { json: parsed.data }).catch((err: unknown) =>
        rethrowNewerEndpointHint(err, 'mv (folder/subtree)'),
      );
      if ((result.renamed_count ?? 0) === 0) {
        throw new CliError(`nothing found at ${normalisePath(oldRef)} to move`, { exitCode: EXIT.NOT_FOUND });
      }
      render(
        { from: normalisePath(oldRef), to: destination, renamedCount: result.renamed_count },
        () => `Moved ${normalisePath(oldRef)} → ${destination} (${result.renamed_count} pages)`,
        globals,
      );
    });
}
