/**
 * Build the MongoDB filter that the `'mongo'` search driver runs against
 * the `Page` collection, plus the small helpers that the driver reuses
 * for the `Revision` body lookup.
 *
 * The driver searches live data — there is no separate search index — so
 * the filter must reproduce the visibility rules that the rest of the app
 * applies when reading pages. Everything is expressed as plain Mongo query
 * conditions (`$regex`, `$or`, `$in`, ...) so the generated filter stays
 * easy to assert in unit tests without touching a real database.
 *
 * Design notes:
 *   - Grant filter mirrors `packages/api/src/models/page.ts`
 *     (`visiblePageGrantOr`): a non-public page (RESTRICTED / SPECIFIED /
 *     OWNER) is hidden unless the viewer created it (`creator`) or is
 *     listed in `grantedUsers`. Anonymous viewers see public pages only;
 *     admins see everything.
 *   - Status filter always drops drafts / deleted pages / redirects so a
 *     keyword search can never leak another user's draft. The search route
 *     has no per-viewer draft filter, so we exclude all drafts here rather
 *     than trying to admit the author's own (matching the ES driver's
 *     `shouldIndex`, which also drops every draft).
 *   - Type filter (portal / public / user) reproduces the legacy
 *     path-shape rules as `$regex` / prefix conditions.
 */

import type { SearchPageType, SearchQueryViewer } from '@crowi/plugin-api';

// Page grant constants — mirror `packages/api/src/models/page.ts`.
// Hard-coded here because the plugin must not import from @crowi/api
// (that would invert the dependency direction and force a runner
// rebuild on every plugin change).
export const GRANT_PUBLIC = 1;
export const GRANT_RESTRICTED = 2;
export const GRANT_SPECIFIED = 3;
export const GRANT_OWNER = 4;

// Page status values — mirror `packages/api/src/models/page.ts`.
export const STATUS_PUBLISHED = 'published';
export const STATUS_DELETED = 'deleted';
export const STATUS_DRAFT = 'draft';

export const DEFAULT_LIMIT = 50;
export const MAX_LIMIT = 200;

/** Clamp a requested page size into the [1, MAX_LIMIT] range. */
export function clampLimit(limit?: number): number {
  if (!limit || limit < 1) return DEFAULT_LIMIT;
  return Math.min(limit, MAX_LIMIT);
}

/** 1-based page → zero-based skip. */
export function pageToSkip(page: number | undefined, limit: number): number {
  const p = page && page > 0 ? page : 1;
  return (p - 1) * limit;
}

/**
 * Escape a user-supplied string so it can be embedded into a `$regex`
 * verbatim (treating every char literally — this is substring search,
 * not a regex DSL exposed to the user).
 */
export function escapeRegex(input: string): string {
  return input.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * `RegExp` matching the query as a case-insensitive substring. Returns
 * `null` for an empty / whitespace-only query so the caller can decide to
 * return zero hits without running a collection scan.
 */
export function keywordRegex(q: string): RegExp | null {
  const trimmed = q.trim();
  if (trimmed === '') return null;
  return new RegExp(escapeRegex(trimmed), 'i');
}

type MongoCondition = Record<string, unknown>;

/**
 * `$or` clause restricting results to pages the viewer may read. Mirrors
 * `visiblePageGrantOr` but additionally honours the anonymous / admin
 * cases the search route distinguishes.
 */
export function grantFilter(viewer?: SearchQueryViewer): MongoCondition[] | null {
  if (!viewer) {
    // Anonymous viewer: public pages only. (legacy-null grant is treated
    // as public.)
    return [{ grant: null }, { grant: GRANT_PUBLIC }];
  }
  if (viewer.isAdmin) {
    // Admin sees everything; no grant constraint.
    return null;
  }
  // Non-admin authenticated viewer: public OR pages they created OR pages
  // explicitly shared with them.
  return [
    { grant: null },
    { grant: GRANT_PUBLIC },
    { grant: GRANT_RESTRICTED, grantedUsers: viewer.id },
    { grant: GRANT_SPECIFIED, grantedUsers: viewer.id },
    { grant: GRANT_OWNER, grantedUsers: viewer.id },
    // The creator can always find their own restricted / owner pages even
    // if they are not listed in grantedUsers.
    { grant: { $ne: GRANT_PUBLIC }, creator: viewer.id },
  ];
}

/**
 * Per-type path condition.
 *   - `portal`: path ends with `/`, excluding `/user/*`
 *   - `public`: path does NOT end with `/`, excluding `/user/*`
 *   - `user`:   `/user/*` prefix
 */
export function typeFilter(type: SearchPageType): MongoCondition {
  switch (type) {
    case 'portal':
      return { path: { $regex: /\/$/ }, $nor: [{ path: { $regex: /^\/user\// } }] };
    case 'public':
      return { path: { $not: /\/$/ }, $nor: [{ path: { $regex: /^\/user\// } }] };
    case 'user':
      return { path: { $regex: /^\/user\// } };
  }
}

/** Prefix condition. Normalises a trailing slash, then anchors `^prefix/`. */
export function pathPrefixFilter(pathPrefix: string): MongoCondition {
  const trimmed = pathPrefix.endsWith('/') ? pathPrefix.slice(0, -1) : pathPrefix;
  return { path: { $regex: new RegExp(`^${escapeRegex(trimmed)}/`) } };
}

export interface BuildPageFilterParams {
  /** Keyword regex (case-insensitive substring). Null = no path match. */
  keyword: RegExp | null;
  viewer?: SearchQueryViewer;
  type?: SearchPageType;
  pathPrefix?: string;
  /** When true, the filter constrains `path` to the keyword too. */
  matchPath: boolean;
}

/**
 * Compose the base visibility + scope filter shared by the path-match and
 * body-match passes. `matchPath` toggles whether the keyword is applied to
 * `path` (the path / title pass) or left out (the body pass narrows by
 * `_id` separately).
 */
export function buildPageFilter(params: BuildPageFilterParams): MongoCondition {
  const { keyword, viewer, type, pathPrefix, matchPath } = params;
  const and: MongoCondition[] = [];

  // Always exclude drafts, deleted pages and redirects. `$in: [null, '']`
  // also matches documents where `redirectTo` is unset (Mongo treats a
  // missing field as `null` for `$in`), so a redirect is anything with a
  // non-empty target.
  and.push({ status: { $nin: [STATUS_DRAFT, STATUS_DELETED] } });
  and.push({ redirectTo: { $in: [null, ''] } });

  if (matchPath && keyword) {
    and.push({ path: { $regex: keyword } });
  }

  const grant = grantFilter(viewer);
  if (grant) {
    and.push({ $or: grant });
  }

  if (type) {
    and.push(typeFilter(type));
  }

  if (pathPrefix) {
    and.push(pathPrefixFilter(pathPrefix));
  }

  return and.length === 1 ? and[0] : { $and: and };
}
