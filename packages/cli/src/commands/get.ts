import { GetPageRequestSchema } from '@crowi/api-contract';
import type { Command } from 'commander';

import { authedFetch, CliError, EXIT } from '../lib/http';
import type { Profile } from '../lib/config';
import type { GlobalOptions } from '../cli';
import { render } from '../lib/output';
import { toPageQuery } from '../lib/page-ref';
import { requireProfile } from './_shared';

/**
 * The `GET /api/v2/pages` response (GetPageResponseSchema). Parsed
 * leniently — only the fields the CLI reads are declared. The markdown body
 * lives at `page.revision.body`; the current revision id (needed by `edit`)
 * at `page.revision._id`.
 */
interface GetPageResponse {
  page?: {
    _id?: string;
    path?: string;
    grant?: number;
    updatedAt?: string;
    revision?: {
      _id?: string;
      body?: string;
      author?: unknown;
      createdAt?: string;
    };
  };
}

/**
 * Shared implementation for `get` and its `cat` alias. Fetches a page via
 * `GET /api/v2/pages` (`pages:read`) and, in human mode, writes the raw
 * markdown body to stdout (pipe-friendly — no trailing chatter). `--json`
 * emits the page meta + body as structured JSON.
 */
async function runGet(pathOrId: string, options: { revision?: string }, command: Command): Promise<void> {
  const { profile, globals } = requireProfile(command);

  const query = toPageQuery(pathOrId, options.revision);
  const parsed = GetPageRequestSchema.safeParse(query);
  if (!parsed.success) {
    throw new CliError(`invalid page reference: ${parsed.error.issues.map((i) => i.message).join('; ')}`, {
      exitCode: EXIT.INVALID,
    });
  }

  const body = await authedFetch<GetPageResponse>(profile, 'GET', '/pages', { query: parsed.data });
  printPage(body, profile, globals);
}

/** Render a fetched page: markdown body to stdout (human) or full JSON. */
function printPage(body: GetPageResponse, _profile: Profile, globals: GlobalOptions): void {
  const page = body.page ?? {};
  const markdown = page.revision?.body ?? '';
  render(
    {
      path: page.path,
      pageId: page._id,
      revisionId: page.revision?._id,
      updatedAt: page.updatedAt,
      body: markdown,
    },
    // Human mode: the body alone, so `crowi get <path> > file.md` works.
    () => markdown,
    globals,
  );
}

/** `crowi get <path-or-id>` — print a page's markdown body. */
export function registerGet(program: Command): void {
  program
    .command('get <path-or-id>')
    .description("Print a page's markdown body (pipe-friendly; --json for metadata)")
    .option('--revision <id>', 'fetch a specific revision instead of the latest')
    .action(async (pathOrId: string, options: { revision?: string }, command: Command) => {
      await runGet(pathOrId, options, command);
    });
}

/** `crowi cat <path-or-id>` — alias of `get`. */
export function registerCat(program: Command): void {
  program
    .command('cat <path-or-id>')
    .description("Alias of `get` — print a page's markdown body")
    .option('--revision <id>', 'fetch a specific revision instead of the latest')
    .action(async (pathOrId: string, options: { revision?: string }, command: Command) => {
      await runGet(pathOrId, options, command);
    });
}
