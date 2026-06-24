import { STATUS_PUBLISHED } from 'src/models/page';

import { defineMigration } from '../types';

/**
 * RFC-0008 §10.1 — `page-status-default` (boot layer).
 *
 * Ported from the former standalone `runPageStatusMigration`
 * (`src/util/page-status-migration.ts`). RFC-0004 introduced a first-class
 * `Page.status` field; pages created before it read back as `null`. This
 * boot migration backfills `status='published'` onto every such legacy row.
 *
 * Why: `Page.isPublished()` already treats `null` as published for
 * back-compat, but the query-level `$or` filters and the collab draft gate
 * are clearer — and future-proof against a stricter `required: true` — when
 * every row carries an explicit value.
 *
 * Behaviour preserved exactly from the old util:
 *   - `{ status: null }` matches both an explicit `null` and a missing field
 *     in MongoDB query semantics, so a single condition covers every legacy
 *     shape.
 *   - Idempotent: the filter only matches rows still unset, so a second run
 *     touches nothing.
 *   - Pages already `published` / `draft` / `deleted` / `deprecated` / `wip`
 *     are left exactly as they are — in particular this never rewrites a
 *     `draft` back to `published`, which would violate the one-way
 *     transition rule.
 */
export const pageStatusDefault = defineMigration({
  id: 'page-status-default',
  fromVersion: '1.x',
  toVersion: '2.0',
  layer: 'boot',
  // Descriptive only: `boot`-layer migrations are auto-applied, never
  // boot-probed, so severity does not gate boot here.
  severity: 'cosmetic',
  description: 'Backfill page.status (RFC-0004)',

  /**
   * Cheap, index-backed probe: `Page.status` is declared `index: true`
   * (models/page.ts), so a single `findOne({ status: null })` lookup is
   * covered by that index and never scans the collection. Pending iff at
   * least one legacy page is still missing a status.
   */
  isPending: async (ctx) => {
    const Page = ctx.crowi.model('Page');
    const legacy = await Page.findOne({ status: null }).select('_id').lean().exec();
    return legacy != null;
  },

  /**
   * Optional `plan` detail: count the remaining legacy rows. Not called at
   * boot — only `isPending` runs there.
   */
  detect: async (ctx) => {
    const Page = ctx.crowi.model('Page');
    const remaining = await Page.countDocuments({ status: null }).exec();
    return {
      summary: `${remaining} legacy page row(s) without status`,
      counts: { remaining },
    };
  },

  stages: [
    {
      name: 'backfill-status',
      fn: async (ctx) => {
        if (ctx.dryRun) {
          return { name: 'backfill-status', transformed: 0 };
        }
        const Page = ctx.crowi.model('Page');
        const result = await Page.updateMany({ status: null }, { $set: { status: STATUS_PUBLISHED } });
        // Mongoose's UpdateResult exposes `modifiedCount`; fall back to 0 for
        // any driver shape that omits it.
        const modified = (result as { modifiedCount?: number }).modifiedCount ?? 0;
        if (modified > 0) {
          ctx.logger.info(`page-status-default: backfilled status='published' on ${modified} legacy page row(s)`);
        }
        return { name: 'backfill-status', transformed: modified };
      },
    },
  ],
});
