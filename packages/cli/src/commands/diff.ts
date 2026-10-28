import { GetPageRequestSchema } from '@crowi/api-contract';
import type { Command } from 'commander';
import { createTwoFilesPatch, FILE_HEADERS_ONLY } from 'diff';
import { resolveBody } from '../lib/body-input';
import { authedFetch, CliError, EXIT } from '../lib/http';
import { render } from '../lib/output';
import { toPageQuery } from '../lib/page-ref';
import { requireProfile } from './_shared';

interface GetPageResponse {
  page?: {
    _id?: string;
    path?: string;
    revision?: { _id?: string; body?: string };
  };
}

/** Strip the run of `\n` / `\r\n` at the very end; nothing else is normalised. */
export function trimTrailingNewlines(text: string): string {
  return text.replace(/(?:\r?\n)+$/, '');
}

/**
 * `crowi diff <path-or-id> --file <file>` — compare the page's latest body
 * with a local file, ignoring only the number of trailing newlines. Exits 0
 * when identical, 1 (with a unified diff on stdout) when they differ.
 */
export function registerDiff(program: Command): void {
  program
    .command('diff <path-or-id>')
    .description("Compare a page's latest body with a local file (exit 0 if identical, 1 with a unified diff if not; trailing newlines are ignored)")
    .requiredOption('-f, --file <path>', 'local file to compare against')
    .action(async (pathOrId: string, options: { file: string }, command: Command) => {
      const { profile, globals } = requireProfile(command);

      // Read the file first so an unreadable --file never costs a request.
      const fileText = (await resolveBody({ file: options.file })) ?? '';

      const query = toPageQuery(pathOrId, undefined);
      const parsed = GetPageRequestSchema.safeParse(query);
      if (!parsed.success) {
        throw new CliError(`invalid page reference: ${parsed.error.issues.map((i) => i.message).join('; ')}`, {
          exitCode: EXIT.INVALID,
        });
      }

      const response = await authedFetch<GetPageResponse>(profile, 'GET', '/pages', { query: parsed.data });
      const page = response.page ?? {};
      const pageBody = trimTrailingNewlines(page.revision?.body ?? '');
      const fileBody = trimTrailingNewlines(fileText);
      const identical = pageBody === fileBody;

      let diff: string | null = null;
      if (!identical) {
        // A trailing `\n` on both sides keeps jsdiff from emitting
        // "\ No newline at end of file" lines.
        const patch = createTwoFilesPatch(`${page.path ?? pathOrId} (wiki)`, options.file, `${pageBody}\n`, `${fileBody}\n`, undefined, undefined, {
          headerOptions: FILE_HEADERS_ONLY,
        });
        diff = patch.endsWith('\n') ? patch.slice(0, -1) : patch;
      }

      const value = {
        identical,
        path: page.path,
        pageId: page._id,
        revisionId: page.revision?._id,
        file: options.file,
        diff,
      };
      if (identical) {
        if (globals.json) {
          render(value, undefined, globals);
        }
        return;
      }
      render(value, diff ?? undefined, globals);
      throw new CliError('page and file differ', { exitCode: EXIT.GENERAL });
    });
}
