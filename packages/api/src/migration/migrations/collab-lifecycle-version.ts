import { defineMigration } from '../types';

/**
 * RFC-0017 Phase 1 §15.1/§16 — `collab-lifecycle-version` (boot layer).
 *
 * Ported from the `page-status-default` template. `Page.collabLifecycleVersion`
 * (RFC-0017 Phase 1) is a monotonic epoch, `default: 0` in the schema, so
 * Mongoose already hydrates a missing on-disk field to `0` on read — this
 * migration is PURE additive housekeeping (stamp `0` explicitly on-disk),
 * not a correctness prerequisite: every epoch comparison in the collab code
 * path (`onAuthenticate` / `executeSave` / `onLoadDocument` replay filter)
 * already treats a missing field as `0` via the schema default.
 *
 * Why still ship it: `PageYjsUpdate` rows and any raw/aggregation read that
 * bypasses the Mongoose schema default (e.g. `.lean()` off a `find` that
 * projects the raw document, or an external tool reading the collection
 * directly) see the field as genuinely absent rather than `0` — stamping it
 * on-disk removes that ambiguity for every future consumer, not just ones
 * that go through this model.
 */
export const collabLifecycleVersion = defineMigration({
  id: 'collab-lifecycle-version',
  // Sequenced alongside the other post-2.0 additive migrations
  // (`revisions-schema-unify` 2.0→2.1, `wikilink-html-recover` 2.1→2.1) —
  // this is a brand-new 2.0-era field, not a 1.x carry-over.
  fromVersion: '2.1',
  toVersion: '2.1',
  layer: 'boot',
  description: 'Backfill page.collabLifecycleVersion (RFC-0017 Phase 1)',

  /**
   * `collabLifecycleVersion` is a bare field with no index (see
   * `models/page.ts`'s schema comment: it is advanced on every lifecycle
   * write but never queried by value, so an index would only add write
   * overhead) — this probe is a collection scan. Accepted: additive
   * `number` backfill, run once at boot, on a field that is cheap to fully
   * scan even on a large `Page` collection (a single existence check per
   * document, no computation).
   */
  isPending: async (ctx) => {
    const Page = ctx.crowi.model('Page');
    const legacy = await Page.findOne({ collabLifecycleVersion: { $exists: false } })
      .select('_id')
      .lean()
      .exec();
    return legacy != null;
  },

  /**
   * Optional `plan` detail: count the remaining legacy rows. Not called at
   * boot — only `isPending` runs there.
   */
  detect: async (ctx) => {
    const Page = ctx.crowi.model('Page');
    const remaining = await Page.countDocuments({ collabLifecycleVersion: { $exists: false } }).exec();
    return {
      summary: `${remaining} legacy page row(s) without collabLifecycleVersion`,
      counts: { remaining },
    };
  },

  stages: [
    {
      name: 'backfill-collab-lifecycle-version',
      fn: async (ctx) => {
        if (ctx.dryRun) {
          return { name: 'backfill-collab-lifecycle-version', transformed: 0 };
        }
        const Page = ctx.crowi.model('Page');
        const result = await Page.updateMany({ collabLifecycleVersion: { $exists: false } }, { $set: { collabLifecycleVersion: 0 } });
        const modified = (result as { modifiedCount?: number }).modifiedCount ?? 0;
        if (modified > 0) {
          ctx.logger.info(`collab-lifecycle-version: backfilled collabLifecycleVersion=0 on ${modified} legacy page row(s)`);
        }
        return { name: 'backfill-collab-lifecycle-version', transformed: modified };
      },
    },
  ],
});
