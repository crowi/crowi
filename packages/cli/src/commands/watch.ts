import { GetWatchStatusRequestSchema, SetWatchStatusRequestSchema } from '@crowi/api-contract';
import type { Command } from 'commander';

import { authedFetch, CliError, EXIT } from '../lib/http';
import { render } from '../lib/output';
import { fetchCurrentPage } from '../lib/page-write';
import { requireProfile } from './_shared';

/** Lenient view of WatchStatusResponseSchema. */
interface WatchStatusResponse {
  watching?: boolean;
}

/**
 * Resolve a `<path-or-id>` to a concrete `page_id` (the watch endpoint keys
 * on `page_id`, not path).
 */
async function resolvePageId(profile: Parameters<typeof fetchCurrentPage>[0], pathOrId: string): Promise<string> {
  const current = await fetchCurrentPage(profile, pathOrId);
  if (!current?.pageId) {
    throw new CliError(`page not found: ${pathOrId}`, { exitCode: EXIT.NOT_FOUND });
  }
  return current.pageId;
}

/**
 * `crowi watch status <path-or-id>` — show whether you watch a page
 * (`GET /api/v2/pages/watch`). Rides the default `pages:read` scope, so no
 * extra login scope is needed.
 */
async function runStatus(pathOrId: string, command: Command): Promise<void> {
  const { profile, globals } = requireProfile(command);
  const pageId = await resolvePageId(profile, pathOrId);
  const parsed = GetWatchStatusRequestSchema.safeParse({ page_id: pageId });
  if (!parsed.success) {
    throw new CliError(`invalid request: ${parsed.error.issues.map((i) => i.message).join('; ')}`, { exitCode: EXIT.INVALID });
  }
  const body = await authedFetch<WatchStatusResponse>(profile, 'GET', '/pages/watch', { query: parsed.data });
  render(body, () => (body.watching ? `Watching ${pathOrId}.` : `Not watching ${pathOrId}.`), globals);
}

/**
 * Subscribe/unsubscribe a page (`PUT /api/v2/pages/watch`). Rides the default
 * `pages:write` scope.
 */
async function runSet(pathOrId: string, watching: boolean, command: Command): Promise<void> {
  const { profile, globals } = requireProfile(command);
  const pageId = await resolvePageId(profile, pathOrId);
  const parsed = SetWatchStatusRequestSchema.safeParse({ page_id: pageId, watching });
  if (!parsed.success) {
    throw new CliError(`invalid request: ${parsed.error.issues.map((i) => i.message).join('; ')}`, { exitCode: EXIT.INVALID });
  }
  const body = await authedFetch<WatchStatusResponse>(profile, 'PUT', '/pages/watch', { json: parsed.data });
  render(body, () => (watching ? `Now watching ${pathOrId}.` : `Stopped watching ${pathOrId}.`), globals);
}

/** Register the `watch` command group (`status` / `subscribe` / `unsubscribe`). */
export function registerWatch(program: Command): void {
  const watch = program.command('watch').description('Watch / unwatch a page for notifications (uses pages:* scope)');

  watch
    .command('status <path-or-id>')
    .description('Show whether you are watching a page')
    .action(async (pathOrId: string, _options: unknown, command: Command) => {
      await runStatus(pathOrId, command);
    });

  watch
    .command('subscribe <path-or-id>')
    .description('Start watching a page')
    .action(async (pathOrId: string, _options: unknown, command: Command) => {
      await runSet(pathOrId, true, command);
    });

  watch
    .command('unsubscribe <path-or-id>')
    .description('Stop watching a page')
    .action(async (pathOrId: string, _options: unknown, command: Command) => {
      await runSet(pathOrId, false, command);
    });
}
