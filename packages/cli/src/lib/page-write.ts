import { CreatePageRequestSchema, GetPageRequestSchema, type PageContentType, UpdatePageRequestSchema } from '@crowi/api-contract';

import type { Profile } from './config';
import { authedFetch, CliError, EXIT } from './http';
import { toPageQuery } from './page-ref';

/**
 * Validate a `--type <kind>` flag (RFC-0020 §C-2, shared by `create` and
 * `update`): only the two literals are accepted, and an invalid value fails
 * BEFORE any body resolution or network call — never sent to the server.
 * `undefined` (flag omitted) passes through unchanged, which is what keeps
 * the server's own default (markdown on create, current kind on update) in
 * effect.
 */
export function parseContentType(raw: string | undefined): PageContentType | undefined {
  if (raw === undefined) return undefined;
  if (raw === 'markdown' || raw === 'artifact') return raw;
  throw new CliError(`invalid --type "${raw}" (expected "markdown" or "artifact")`, { exitCode: EXIT.INVALID });
}

/**
 * Minimal lenient view of `GET /api/pages` used by the write commands:
 * the body (`page.revision.body`) plus the optimistic-lock token
 * (`page.revision._id`) that must be echoed back on `PUT`.
 */
export interface CurrentPage {
  pageId?: string;
  path?: string;
  body: string;
  revisionId?: string;
  /**
   * RFC-0020 §R — the selected revision's own kind (falls back to the
   * page's current-kind hint when the response has no populated
   * `revision`, which `GET /pages` always does for a page with a pointer —
   * see `fetchCurrentPage` below). Read by `edit` to pick the temp file
   * extension and by `get --json` to report `contentType`.
   */
  contentType?: string;
}

interface GetPageResponse {
  page?: {
    _id?: string;
    path?: string;
    contentType?: string;
    revision?: { _id?: string; body?: string; contentType?: string };
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
 * RFC-0020 §C-1 — the discriminator rides a header, never the JSON body:
 * `CreatePageRequestSchema` / `UpdatePageRequestSchema` have no
 * `content_type` field, so it must not be folded into `parsed.data`.
 */
const contentTypeHeaders = (contentType: PageContentType | undefined): Record<string, string> | undefined =>
  contentType ? { 'X-Crowi-Page-Content-Type': contentType } : undefined;

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
    // RFC-0020 §R-1/R-3b — the selected revision's own kind is
    // authoritative; the page-level `contentType` is only a same-write hint
    // for the fallback case (no populated revision in the response).
    const contentType = page.revision?.contentType ?? page.contentType;
    return {
      pageId: page._id,
      path: page.path,
      body: page.revision?.body ?? '',
      revisionId: page.revision?._id,
      contentType,
    };
  } catch (err) {
    if (err instanceof CliError && err.status === 404) {
      return null;
    }
    throw err;
  }
}

/**
 * Update an existing page via `PUT /api/pages` with an optimistic-lock
 * `revision_id`. A stale revision yields a 409 PageRevisionError; callers
 * decide whether to ABORT (default) or re-fetch + retry (`--force`).
 */
export async function putPage(
  profile: Profile,
  args: { pageId: string; body: string; revisionId?: string; grant?: number; contentType?: PageContentType },
): Promise<SaveResult> {
  const parsed = UpdatePageRequestSchema.safeParse({
    page_id: args.pageId,
    body: args.body,
    revision_id: args.revisionId,
    grant: args.grant,
  });
  if (!parsed.success) {
    throw new CliError(`invalid update: ${parsed.error.issues.map((i) => i.message).join('; ')}`, { exitCode: EXIT.INVALID });
  }
  const result = await authedFetch<WritePageResponse>(profile, 'PUT', '/pages', { json: parsed.data, headers: contentTypeHeaders(args.contentType) });
  const page = result.page ?? {};
  return { pageId: page._id, path: page.path, revisionId: page.revision?._id, created: false };
}

/**
 * Create a new page via `POST /api/pages` (used when an `edit` target did
 * not exist yet, and — via `create`'s RFC-0020 §C-1b unification — by
 * `crowi create` itself).
 */
export async function postPage(profile: Profile, args: { path: string; body: string; grant?: number; contentType?: PageContentType }): Promise<SaveResult> {
  const parsed = CreatePageRequestSchema.safeParse({ path: args.path, body: args.body, grant: args.grant });
  if (!parsed.success) {
    throw new CliError(`invalid page: ${parsed.error.issues.map((i) => i.message).join('; ')}`, { exitCode: EXIT.INVALID });
  }
  const result = await authedFetch<WritePageResponse>(profile, 'POST', '/pages', { json: parsed.data, headers: contentTypeHeaders(args.contentType) });
  const page = result.page ?? {};
  return { pageId: page._id, path: page.path, revisionId: page.revision?._id, created: true };
}

/** Whether a thrown error is a 409 optimistic-lock conflict from `PUT /pages`. */
export function isRevisionConflict(err: unknown): boolean {
  return err instanceof CliError && (err.status === 409 || err.apiCode === 'PAGE_REVISION_ERROR');
}
