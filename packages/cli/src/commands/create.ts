import type { Command } from 'commander';

import { resolveBody } from '../lib/body-input';
import { editInEditor, resolveEditor } from '../lib/editor';
import { CliError, EXIT } from '../lib/http';
import { info, render } from '../lib/output';
import { normalisePath } from '../lib/page-ref';
import { parseContentType, postPage } from '../lib/page-write';
import { requireProfile } from './_shared';

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
 * `crowi create <path>` — create a new page via `POST /api/pages`
 * (`pages:write`, in the default login scope). The body comes from
 * `--message` / `--file` / `--stdin`, or from `$EDITOR` when none is given
 * (an empty editor buffer aborts so an accidental run never creates a blank
 * page). `--grant` sets visibility (1=public 2=restricted 3=specified
 * 4=owner). `--type` declares the page kind (RFC-0020) — omit it to create
 * an ordinary markdown page; pass `--type artifact` only when `body` is a
 * single self-contained HTML document (no external script/stylesheet/
 * image/module references, no relative paths — embed any binary asset as a
 * `data:` URI). The kind is never inferred from `--file`'s extension or
 * from the body's own content.
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
    .option(
      '--type <kind>',
      'page kind: "markdown" (default) or "artifact" (body must be a single self-contained HTML document, no external references, data: URIs for binaries)',
    )
    .action(
      async (path: string, options: { message?: string; file?: string; stdin?: boolean; editor?: string; grant?: string; type?: string }, command: Command) => {
        const { profile, globals } = requireProfile(command);

        const grant = parseGrant(options.grant);
        const contentType = parseContentType(options.type);

        // Body precedence: explicit source (--message/--file/--stdin), else
        // open an editor seeded with an empty buffer.
        let body = await resolveBody(options);
        if (body === undefined) {
          info(`Opening editor for new page ${normalisePath(path)}…`, globals);
          body = await editInEditor('', resolveEditor(options.editor), contentType === 'artifact' ? 'html' : 'md');
          if (body.trim() === '') {
            throw new CliError('empty body — page not created', { exitCode: EXIT.INVALID });
          }
        }

        const result = await postPage(profile, { path: normalisePath(path), body, grant, contentType });
        render({ path: result.path, pageId: result.pageId, revisionId: result.revisionId }, () => `Created ${result.path ?? normalisePath(path)}`, globals);
      },
    );
}
