import { CreatePageRequestSchema } from '@crowi/api-contract';
import type { Command } from 'commander';

import { resolveBody } from '../lib/body-input';
import { editInEditor, resolveEditor } from '../lib/editor';
import { authedFetch, CliError, EXIT } from '../lib/http';
import { info, render } from '../lib/output';
import { normalisePath } from '../lib/page-ref';
import { requireProfile } from './_shared';

/**
 * The `POST /api/v2/pages` response (PageResponseSchema). Parsed leniently —
 * only the fields the CLI reports back are declared.
 */
interface CreatePageResponse {
  page?: {
    _id?: string;
    path?: string;
    revision?: { _id?: string };
  };
}

/** Parse a `--grant <n>` flag into an integer, rejecting non-numeric input. */
function parseGrant(raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined;
  const n = Number(raw);
  if (!Number.isInteger(n)) {
    throw new CliError(`invalid --grant "${raw}" (expected 1=public 2=restricted 3=specified 4=owner)`, { exitCode: EXIT.INVALID });
  }
  return n;
}

/**
 * `crowi create <path>` — create a new page via `POST /api/v2/pages`
 * (`pages:write`, in the default login scope). The body comes from
 * `--message` / `--file` / `--stdin`, or from `$EDITOR` when none is given
 * (an empty editor buffer aborts so an accidental run never creates a blank
 * page). `--grant` sets visibility (1=public 2=restricted 3=specified
 * 4=owner).
 */
export function registerCreate(program: Command): void {
  program
    .command('create <path>')
    .description('Create a new page (body from --message / --file / --stdin / $EDITOR)')
    .option('-m, --message <text>', 'page body supplied literally')
    .option('-f, --file <path>', 'read the page body from a local file')
    .option('--stdin', 'read the page body from standard input')
    .option('--editor <bin>', 'editor to open when no body source is given (overrides $EDITOR)')
    .option('--grant <n>', 'visibility: 1=public 2=restricted 3=specified 4=owner')
    .action(async (path: string, options: { message?: string; file?: string; stdin?: boolean; editor?: string; grant?: string }, command: Command) => {
      const { profile, globals } = requireProfile(command);

      const grant = parseGrant(options.grant);

      // Body precedence: explicit source (--message/--file/--stdin), else
      // open an editor seeded with an empty buffer.
      let body = await resolveBody(options);
      if (body === undefined) {
        info(`Opening editor for new page ${normalisePath(path)}…`, globals);
        body = await editInEditor('', resolveEditor(options.editor));
        if (body.trim() === '') {
          throw new CliError('empty body — page not created', { exitCode: EXIT.INVALID });
        }
      }

      const parsed = CreatePageRequestSchema.safeParse({ path: normalisePath(path), body, grant });
      if (!parsed.success) {
        throw new CliError(`invalid page: ${parsed.error.issues.map((i) => i.message).join('; ')}`, { exitCode: EXIT.INVALID });
      }

      const result = await authedFetch<CreatePageResponse>(profile, 'POST', '/pages', { json: parsed.data });
      const created = result.page ?? {};
      render({ path: created.path, pageId: created._id, revisionId: created.revision?._id }, () => `Created ${created.path ?? normalisePath(path)}`, globals);
    });
}
