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

  // `crowi get -` reads the page reference from stdin (first non-empty line),
  // so `crowi search foo --template '{{path}}' | head -1 | crowi get -` pipes.
  const reference = pathOrId === '-' ? await readReferenceFromStdin() : pathOrId;

  const query = toPageQuery(reference, options.revision);
  const parsed = GetPageRequestSchema.safeParse(query);
  if (!parsed.success) {
    throw new CliError(`invalid page reference: ${parsed.error.issues.map((i) => i.message).join('; ')}`, {
      exitCode: EXIT.INVALID,
    });
  }

  const body = await authedFetch<GetPageResponse>(profile, 'GET', '/pages', { query: parsed.data });
  printPage(body, profile, globals);
}

/**
 * Read a page reference (path or id) from stdin for `crowi get -`. Takes the
 * first non-empty, trimmed line so a piped multi-line list still resolves a
 * single page; errors if stdin is empty.
 */
async function readReferenceFromStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
  }
  const text = Buffer.concat(chunks).toString('utf8');
  const first = text
    .split('\n')
    .map((line) => line.trim())
    .find((line) => line.length > 0);
  if (!first) {
    throw new CliError('no page reference on stdin (expected a path or id)', { exitCode: EXIT.INVALID });
  }
  return first;
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
