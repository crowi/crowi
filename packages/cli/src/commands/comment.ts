import { AddCommentRequestSchema, ListCommentsRequestSchema } from '@crowi/api-contract';
import type { Command } from 'commander';
import { resolveBody } from '../lib/body-input';
import { ensureCapability } from '../lib/capability';
import { authedFetch, CliError, EXIT } from '../lib/http';
import { render } from '../lib/output';
import { fetchCurrentPage } from '../lib/page-write';
import { requireProfile, rethrowScopeHint } from './_shared';

/**
 * Lenient views of the comment responses (ListCommentsResponseSchema /
 * AddCommentResponseSchema). Only the fields the CLI renders are declared.
 */
interface CommentView {
  _id?: string;
  comment?: string;
  createdAt?: string;
  creator?: { username?: string; name?: string } | string | null;
}
interface ListCommentsResponse {
  comments?: CommentView[];
}
interface AddCommentResponse {
  comment?: CommentView;
  newlyWatching?: boolean;
}

/** Display name for a (possibly populated, possibly string) comment creator. */
function creatorName(creator: CommentView['creator']): string {
  if (!creator) return '(unknown)';
  if (typeof creator === 'string') return creator;
  return creator.username ?? creator.name ?? '(unknown)';
}

/**
 * `crowi comment list <path-or-id>` — list a page's comments
 * (`GET /api/v2/comments`, needs `comments:read`). Resolves the page to its
 * `page_id` first (via `GET /pages`) so the user can pass a path.
 */
async function runList(pathOrId: string, command: Command): Promise<void> {
  const { profile, globals } = requireProfile(command);
  if (!(await ensureCapability(profile, 'comments', 'comments'))) {
    process.exitCode = EXIT.UNAVAILABLE;
    return;
  }

  const current = await fetchCurrentPage(profile, pathOrId);
  if (!current?.pageId) {
    throw new CliError(`page not found: ${pathOrId}`, { exitCode: EXIT.NOT_FOUND });
  }

  const parsed = ListCommentsRequestSchema.safeParse({ page_id: current.pageId });
  if (!parsed.success) {
    throw new CliError(`invalid request: ${parsed.error.issues.map((i) => i.message).join('; ')}`, { exitCode: EXIT.INVALID });
  }

  let body: ListCommentsResponse;
  try {
    body = await authedFetch<ListCommentsResponse>(profile, 'GET', '/comments', { query: parsed.data });
  } catch (err) {
    rethrowScopeHint(err, 'comments:read');
  }

  const comments = body.comments ?? [];
  render(
    body,
    () => {
      if (comments.length === 0) return '(no comments)';
      return comments.map((c) => `${creatorName(c.creator)}: ${(c.comment ?? '').replace(/\s+/g, ' ').trim()}`).join('\n');
    },
    globals,
  );
}

/**
 * `crowi comment add <path-or-id>` — add a comment
 * (`POST /api/v2/comments`, needs `comments:write`). The comment text comes
 * from `--message`, `--file`, or stdin. The required `revision_id` is read
 * from the just-fetched page (`page.revision._id`).
 */
async function runAdd(pathOrId: string, options: { message?: string; file?: string }, command: Command): Promise<void> {
  const { profile, globals } = requireProfile(command);
  if (!(await ensureCapability(profile, 'comments', 'comments'))) {
    process.exitCode = EXIT.UNAVAILABLE;
    return;
  }

  // Fall back to stdin only when neither --message nor --file is given, so we
  // never block on stdin when text was supplied on the command line.
  const useStdin = options.message === undefined && options.file === undefined;
  const text = await resolveBody({ message: options.message, file: options.file, stdin: useStdin });
  if (text === undefined || text.trim() === '') {
    throw new CliError('empty comment — provide text via --message, --file, or stdin', { exitCode: EXIT.INVALID });
  }

  const current = await fetchCurrentPage(profile, pathOrId);
  if (!current?.pageId || !current.revisionId) {
    throw new CliError(`page not found: ${pathOrId}`, { exitCode: EXIT.NOT_FOUND });
  }

  const parsed = AddCommentRequestSchema.safeParse({
    page_id: current.pageId,
    revision_id: current.revisionId,
    comment: text,
  });
  if (!parsed.success) {
    throw new CliError(`invalid comment: ${parsed.error.issues.map((i) => i.message).join('; ')}`, { exitCode: EXIT.INVALID });
  }

  let body: AddCommentResponse;
  try {
    body = await authedFetch<AddCommentResponse>(profile, 'POST', '/comments', { json: parsed.data });
  } catch (err) {
    rethrowScopeHint(err, 'comments:write');
  }

  render(body, () => `Comment added to ${current.path ?? pathOrId}.`, globals);
}

/** Register the `comment` command group (`list` / `add`). */
export function registerComment(program: Command): void {
  const comment = program.command('comment').description('List or add comments on a page (needs comments:* scope)');

  comment
    .command('list <path-or-id>')
    .description('List comments on a page')
    .action(async (pathOrId: string, _options: unknown, command: Command) => {
      await runList(pathOrId, command);
    });

  comment
    .command('add <path-or-id>')
    .description('Add a comment to a page (text via --message / --file / stdin)')
    .option('-m, --message <text>', 'comment text')
    .option('-f, --file <path>', 'read the comment text from a file')
    .action(async (pathOrId: string, options: { message?: string; file?: string }, command: Command) => {
      await runAdd(pathOrId, options, command);
    });
}
