import { defineMigration } from '../types';
import type { MigrationContext } from '../types';

/**
 * v1 → v2.0 — `relocate-reserved-api-paths` (preflight layer).
 *
 * v2 reserves the `/api` namespace as the reverse-proxied backend route
 * surface: the front proxy forwards `/api/v2/*` to the api, and
 * `Page.isCreatableName` now refuses to create / rename a page under
 * `/api`. v1, however, served its API at `/_api/*` (note the leading
 * underscore — reserved by the `/_*` rule in `Page.isCreatableName`), so
 * `/api/*` was a perfectly ordinary wiki page path. An upgraded wiki may hold
 * legitimate v1 pages under `/api/*` that v2 would strand: the web app
 * 404s the reserved namespace, and any page that happened to live at
 * `/api/v2/*` is shadowed by the proxy entirely.
 *
 * This migration moves every surviving page out of `/api/*` into
 * `/api-legacy/*` (preserving the rest of the path) so nothing is lost.
 * `/api-legacy` is itself creatable (the reserved match is segment-bounded,
 * so `api-legacy` does not collide). A pre-existing page at the relocation
 * target is avoided by appending a `-N` suffix.
 *
 * It is `preflight` because it rewrites user-visible page paths: boot
 * blocks until an operator runs `crowi-admin migrate apply` in a
 * maintenance window. The move is done with plain `updateOne` /
 * `updateMany` on the Page + Revision collections rather than
 * `Page.rename`, deliberately bypassing the `pageEvent('update')` chain
 * (mention dispatch / render-cache / backlink) — a path-only relocation of
 * a legacy page must not re-notify mentioned users. No redirect stub is
 * left at the old path: it sits inside the reserved namespace (unreachable
 * by the web app, and `createPage` would itself reject it).
 */

/**
 * The reserved backend namespace, segment-bounded: matches `/api` and
 * `/api/...` but never `/apiary`. Mirrors the `api` arm of the server's
 * `Page.isCreatableName` forbidden list.
 */
const RESERVED_API_PATH = /^\/api(\/|$)/;

/** Relocation root for displaced `/api/*` pages. */
const RELOCATE_ROOT = '/api-legacy';

/** Cap on suffix probing when the relocation target is already taken. */
const MAX_SUFFIX_ATTEMPTS = 1000;

/** `/api` → `/api-legacy`, `/api/foo` → `/api-legacy/foo`, `/api/` → `/api-legacy/`. */
export function relocatedApiPath(oldPath: string): string {
  return RELOCATE_ROOT + oldPath.slice('/api'.length);
}

/**
 * The first relocation target not already occupied by another page. Tries
 * the bare relocated path, then `-1`, `-2`, … . Collisions are near-
 * impossible in practice (`/api-legacy` is a fresh namespace), so this is
 * defensive; it throws rather than loop unboundedly.
 */
async function findFreeTarget(Page: { exists: (q: Record<string, unknown>) => Promise<unknown> }, candidate: string): Promise<string> {
  if (!(await Page.exists({ path: candidate }))) return candidate;
  for (let i = 1; i <= MAX_SUFFIX_ATTEMPTS; i++) {
    const next = `${candidate}-${i}`;
    if (!(await Page.exists({ path: next }))) return next;
  }
  throw new Error(`relocate-reserved-api-paths: could not find a free relocation target for '${candidate}' after ${MAX_SUFFIX_ATTEMPTS} attempts`);
}

/** Pages still living under the reserved `/api` namespace, `_id` + `path` only. */
async function collectApiPages(ctx: MigrationContext): Promise<{ _id: unknown; path: string }[]> {
  const Page = ctx.crowi.model('Page');
  const rows = await Page.find({ path: RESERVED_API_PATH }).select('_id path').lean().exec();
  return (rows as { _id: unknown; path: string }[]).map((r) => ({ _id: r._id, path: r.path }));
}

export const relocateReservedApiPaths = defineMigration({
  id: 'relocate-reserved-api-paths',
  fromVersion: '1.x',
  toVersion: '2.0',
  layer: 'preflight',
  description: 'Relocate v1 pages out of the v2-reserved /api namespace into /api-legacy',

  /**
   * Pending iff any page still lives under `/api/*`. The anchored regex on
   * the unique-indexed `path` field lets the planner use the index for the
   * `/api` literal prefix, so this stays an index-assisted existence probe
   * rather than a full-collection scan (§4.2.1).
   */
  isPending: async (ctx) => {
    const Page = ctx.crowi.model('Page');
    // Crowi's `Page.exists` resolves to a boolean (see `checkPagesRenamable`),
    // not Mongoose's `{ _id } | null` — `Boolean(...)` is correct either way.
    return Boolean(await Page.exists({ path: RESERVED_API_PATH }));
  },

  /** Full scan for `plan`: count the pages that would move. Not called at boot. */
  detect: async (ctx) => {
    const pages = await collectApiPages(ctx);
    return {
      summary: `${pages.length} page(s) under the reserved /api namespace would move to ${RELOCATE_ROOT}/*`,
      counts: { pages: pages.length },
    };
  },

  stages: [
    {
      name: 'relocate-api-pages',
      fn: async (ctx) => {
        const Page = ctx.crowi.model('Page');
        const Revision = ctx.crowi.model('Revision');
        // Materialise the work-list up front: moving a page out of `/api/*`
        // removes it from the query, so a live cursor could skip or double-
        // count mid-iteration. The set is small (pages under one namespace).
        const pages = await collectApiPages(ctx);
        ctx.progress.setTotal(pages.length);

        if (ctx.dryRun) {
          // Preview only — resolve targets (read-only) so the report reflects
          // collision handling, but perform no writes.
          let wouldMove = 0;
          for (const page of pages) {
            await findFreeTarget(Page, relocatedApiPath(page.path));
            wouldMove += 1;
            ctx.progress.increment();
          }
          return { name: 'relocate-api-pages', transformed: 0, stats: { wouldMove } };
        }

        let moved = 0;
        for (const page of pages) {
          const target = await findFreeTarget(Page, relocatedApiPath(page.path));
          // Page + its revisions both carry `path`; update both. Plain
          // updateOne/updateMany so no pageEvent fires (see module JSDoc).
          await Page.updateOne({ _id: page._id }, { $set: { path: target } });
          await Revision.updateMany({ path: page.path }, { $set: { path: target } });
          ctx.logger.info(`relocate-reserved-api-paths: moved '${page.path}' -> '${target}'`);
          moved += 1;
          ctx.progress.increment();
        }
        return { name: 'relocate-api-pages', transformed: moved };
      },
    },
  ],
});
