import { CreatePageRequestSchema, GetPageRequestSchema, UpdatePageRequestSchema } from '@crowi/api-contract';

import type { Profile } from './config';
import { authedFetch, CliError, EXIT } from './http';
import { toPageQuery } from './page-ref';

/**
 * Minimal lenient view of `GET /api/v2/pages` used by the write commands:
 * the markdown body (`page.revision.body`) plus the optimistic-lock token
 * (`page.revision._id`) that must be echoed back on `PUT`.
 */
export interface CurrentPage {
  pageId?: string;
  path?: string;
  body: string;
  revisionId?: string;
}

interface GetPageResponse {
  page?: {
    _id?: string;
    path?: string;
    revision?: { _id?: string; body?: string };
  };
}

interface WritePageResponse {
  page?: {
    _id?: string;
    path?: string;
    revision?: { _id?: string };
  };
}

/**
 * The result of saving a page: its path + new revision id, and whether the
 * save created a brand-new page (`POST`) or updated an existing one (`PUT`).
 */
export interface SaveResult {
  pageId?: string;
  path?: string;
  revisionId?: string;
  created: boolean;
}

/**
 * Fetch the current state of a page by `<path-or-id>`. Returns `null` when
 * the page does not exist (404 PAGE_NOT_FOUND) so callers can treat the edit
 * as a create-on-save. Other errors (403, etc.) propagate.
 */
export async function fetchCurrentPage(profile: Profile, pathOrId: string): Promise<CurrentPage | null> {
  const query = toPageQuery(pathOrId);
  const parsed = GetPageRequestSchema.safeParse(query);
  if (!parsed.success) {
    throw new CliError(`invalid page reference: ${parsed.error.issues.map((i) => i.message).join('; ')}`, { exitCode: EXIT.INVALID });
  }

  try {
    const body = await authedFetch<GetPageResponse>(profile, 'GET', '/pages', { query: parsed.data });
    const page = body.page ?? {};
    return {
      pageId: page._id,
      path: page.path,
      body: page.revision?.body ?? '',
      revisionId: page.revision?._id,
    };
  } catch (err) {
    if (err instanceof CliError && err.status === 404) {
      return null;
    }
    throw err;
  }
}

/**
 * Update an existing page via `PUT /api/v2/pages` with an optimistic-lock
 * `revision_id`. A stale revision yields a 409 PageRevisionError; callers
 * decide whether to ABORT (default) or re-fetch + retry (`--force`).
 */
export async function putPage(profile: Profile, args: { pageId: string; body: string; revisionId?: string; grant?: number }): Promise<SaveResult> {
  const parsed = UpdatePageRequestSchema.safeParse({
    page_id: args.pageId,
    body: args.body,
    revision_id: args.revisionId,
    grant: args.grant,
  });
  if (!parsed.success) {
    throw new CliError(`invalid update: ${parsed.error.issues.map((i) => i.message).join('; ')}`, { exitCode: EXIT.INVALID });
  }
  const result = await authedFetch<WritePageResponse>(profile, 'PUT', '/pages', { json: parsed.data });
  const page = result.page ?? {};
  return { pageId: page._id, path: page.path, revisionId: page.revision?._id, created: false };
}

/**
 * Create a new page via `POST /api/v2/pages` (used when an `edit` target did
 * not exist yet).
 */
export async function postPage(profile: Profile, args: { path: string; body: string; grant?: number }): Promise<SaveResult> {
  const parsed = CreatePageRequestSchema.safeParse({ path: args.path, body: args.body, grant: args.grant });
  if (!parsed.success) {
    throw new CliError(`invalid page: ${parsed.error.issues.map((i) => i.message).join('; ')}`, { exitCode: EXIT.INVALID });
  }
  const result = await authedFetch<WritePageResponse>(profile, 'POST', '/pages', { json: parsed.data });
  const page = result.page ?? {};
  return { pageId: page._id, path: page.path, revisionId: page.revision?._id, created: true };
}

/** Whether a thrown error is a 409 optimistic-lock conflict from `PUT /pages`. */
export function isRevisionConflict(err: unknown): boolean {
  return err instanceof CliError && (err.status === 409 || err.apiCode === 'PAGE_REVISION_ERROR');
}
