import { AddBookmarkRequestSchema, RemoveBookmarkRequestSchema } from '@crowi/api-contract';
import type { Command } from 'commander';

import { authedFetch, CliError, EXIT } from '../lib/http';
import { render } from '../lib/output';
import { fetchCurrentPage } from '../lib/page-write';
import { requireProfile, rethrowScopeHint } from './_shared';

/** Lenient views of the bookmark responses. */
interface BookmarkView {
  _id?: string;
  page?: { path?: string; _id?: string };
  createdAt?: string;
}
interface BookmarkResponse {
  bookmark?: BookmarkView | null;
}
interface ListMyBookmarksResponse {
  bookmarks?: BookmarkView[];
  total?: number;
}

/**
 * Resolve a `<path-or-id>` to a concrete `page_id` for the bookmark write
 * endpoints (which key on `page_id`, not path).
 */
async function resolvePageId(profile: Parameters<typeof fetchCurrentPage>[0], pathOrId: string): Promise<string> {
  const current = await fetchCurrentPage(profile, pathOrId);
  if (!current?.pageId) {
    throw new CliError(`page not found: ${pathOrId}`, { exitCode: EXIT.NOT_FOUND });
  }
  return current.pageId;
}

/**
 * `crowi bookmark add <path-or-id>` — bookmark a page
 * (`POST /api/v2/bookmarks`, needs `bookmarks:write`).
 */
async function runAdd(pathOrId: string, command: Command): Promise<void> {
  const { profile, globals } = requireProfile(command);
  // No capability pre-flight: `bookmarks` is in the static baseline; the real
  // gate is the `bookmarks:write` scope (rethrowScopeHint below).
  const pageId = await resolvePageId(profile, pathOrId);
  const parsed = AddBookmarkRequestSchema.safeParse({ page_id: pageId });
  if (!parsed.success) {
    throw new CliError(`invalid request: ${parsed.error.issues.map((i) => i.message).join('; ')}`, { exitCode: EXIT.INVALID });
  }

  let body: BookmarkResponse;
  try {
    body = await authedFetch<BookmarkResponse>(profile, 'POST', '/bookmarks', { json: parsed.data });
  } catch (err) {
    rethrowScopeHint(err, 'bookmarks:write');
  }

  // Add returns { bookmark: null } when the page is missing / not granted.
  if (!body.bookmark) {
    throw new CliError(`could not bookmark ${pathOrId} (page missing or not accessible)`, { exitCode: EXIT.NOT_FOUND });
  }
  render(body, () => `Bookmarked ${pathOrId}.`, globals);
}

/**
 * `crowi bookmark remove <path-or-id>` — remove a bookmark (idempotent)
 * (`DELETE /api/v2/bookmarks`, needs `bookmarks:write`).
 */
async function runRemove(pathOrId: string, command: Command): Promise<void> {
  const { profile, globals } = requireProfile(command);
  // No capability pre-flight (see runAdd) — gate is the `bookmarks:write` scope.
  const pageId = await resolvePageId(profile, pathOrId);
  const parsed = RemoveBookmarkRequestSchema.safeParse({ page_id: pageId });
  if (!parsed.success) {
    throw new CliError(`invalid request: ${parsed.error.issues.map((i) => i.message).join('; ')}`, { exitCode: EXIT.INVALID });
  }

  let body: unknown;
  try {
    body = await authedFetch<unknown>(profile, 'DELETE', '/bookmarks', { json: parsed.data });
  } catch (err) {
    rethrowScopeHint(err, 'bookmarks:write');
  }
  render(body, () => `Removed bookmark for ${pathOrId}.`, globals);
}

/**
 * `crowi bookmark list` — list the signed-in user's bookmarks
 * (`GET /api/v2/bookmarks/me`, needs `bookmarks:read`).
 */
async function runList(options: { limit?: string; offset?: string }, command: Command): Promise<void> {
  const { profile, globals } = requireProfile(command);
  // No capability pre-flight (see runAdd) — gate is the `bookmarks:read` scope.
  let body: ListMyBookmarksResponse;
  try {
    body = await authedFetch<ListMyBookmarksResponse>(profile, 'GET', '/bookmarks/me', {
      query: { limit: options.limit, offset: options.offset },
    });
  } catch (err) {
    rethrowScopeHint(err, 'bookmarks:read');
  }

  const bookmarks = body.bookmarks ?? [];
  render(
    body,
    () => {
      if (bookmarks.length === 0) return '(no bookmarks)';
      return bookmarks.map((b) => b.page?.path ?? b.page?._id ?? '(unknown)').join('\n');
    },
    globals,
  );
}

/** Register the `bookmark` command group (`add` / `remove` / `list`). */
export function registerBookmark(program: Command): void {
  const bookmark = program.command('bookmark').description('Manage your page bookmarks (needs bookmarks:* scope)');

  bookmark
    .command('add <path-or-id>')
    .description('Bookmark a page')
    .action(async (pathOrId: string, _options: unknown, command: Command) => {
      await runAdd(pathOrId, command);
    });

  bookmark
    .command('remove <path-or-id>')
    .description('Remove a page bookmark (idempotent)')
    .action(async (pathOrId: string, _options: unknown, command: Command) => {
      await runRemove(pathOrId, command);
    });

  bookmark
    .command('list')
    .description('List your bookmarks')
    .option('--limit <n>', 'max results')
    .option('--offset <n>', 'pagination offset')
    .action(async (options: { limit?: string; offset?: string }, command: Command) => {
      await runList(options, command);
    });
}
