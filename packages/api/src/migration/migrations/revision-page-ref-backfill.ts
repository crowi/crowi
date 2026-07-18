import type { Types } from 'mongoose';

import type { RevisionModel } from 'src/models/revision';
import { defineMigration } from '../types';

/**
 * DC-5 / `feature-revision-page-ref` — `revision-page-ref-backfill` (boot layer).
 *
 * `Revision` gained an immutable `page: ObjectId` ref (`models/revision.ts`,
 * set once in `prepareRevision`) alongside the pre-existing mutable `path`
 * string. This migration backfills `page` onto every revision written before
 * the field existed, using `path` as the one-time bridge: `Page.path` is a
 * unique index, so at any given moment exactly one page owns a given path
 * string, and every standard revision-lifecycle path (hard delete removes its
 * revisions too via `Revision.removeRevisionsByPageId`, rename keeps
 * `revision.path` in sync via `Revision.updateRevisionListByPath`) keeps that
 * 1:1 correspondence intact for as long as a revision has never been
 * backfilled. See the "orphan" note below for the standard-path deviations
 * this can't resolve.
 *
 * ── RFC-0008 §LAYER: boot, not preflight (deliberate deviation) ─────────
 * Every other migration shaped "walk every page, mutate its related rows"
 * (`wikilink-format` / `wikilink-html-recover` / `files-url-to-attachments` /
 * `user-unique-prepare`) is `layer: 'preflight'` in this codebase — heavy
 * work belongs in an explicit, operator-triggered maintenance window. This
 * migration keeps the same page-cursor + per-page-batch shape (its target
 * value, the owning page id, varies per page, so — unlike
 * `revisions-schema-unify`'s constant `type: 'snapshot'` — it can't collapse
 * to a single flat `updateMany`) yet is still `layer: 'boot'`, because the
 * correctness stakes differ from every preflight precedent above: those are
 * all cosmetic (stale body syntax) or a narrow index-safety prep. Once
 * `hono/handlers/revision.ts`'s `getRevisionsRoute` / `getRevisionRoute`
 * switch to resolving the owning page via `revision.page` (this feature's
 * whole point — path reverse-lookup can resolve to a DIFFERENT page that
 * later reused the same path string), a revision instance with no `page` is
 * unreadable through those endpoints (fails closed to 404, not a fallback to
 * the old path lookup — see that file's comments). Leaving this as
 * `preflight` would mean every pre-existing revision 404s on those two routes
 * on every install until an operator remembers to run `crowi-admin migrate
 * apply` — an unacceptable regression for a routine version bump. Batching
 * the per-page writes into `bulkWrite` calls (default 500 pages/batch) keeps
 * a single boot pass bounded to O(pages / batchSize) round trips instead of
 * one `await` per page, so this stays proportionate for a boot-auto migration
 * even on larger installs.
 * ─────────────────────────────────────────────────────────────────────
 *
 * ── Path-reuse safety: a `createdAt` lower bound, not `path` alone ──────
 * A naive `updateMany({ path, page: { $exists: false } }, { $set: { page } })`
 * per current page is UNSAFE: it silently attributes to the current page
 * every legacy revision that ever shared that path string — including one
 * stranded by a standard-lifecycle deviation from a *different, now-deleted*
 * page (e.g. the delete/revision-cleanup pair got interrupted, or a raw
 * collection edit removed the page row without going through
 * `Page.removePage`). Reviewer-caught (round 1): private page A is deleted,
 * its revision is left behind, an unrelated PUBLIC page B is later created at
 * the same path — a bare path match would hand A's private revision to B's
 * id, which is exactly the grant leak this feature exists to close.
 *
 * The fix: every revision `prepareRevision` ever writes for a page is
 * created no earlier than that page's own `createdAt` (the page row is
 * always persisted before its first revision — see `Page.createPage`). So a
 * legacy revision can only genuinely belong to the CURRENT occupant of a
 * path if `revision.createdAt >= page.createdAt`; anything older predates
 * that page's existence and must be a stranded row from a prior occupant.
 * The per-page `updateMany` filter includes `createdAt: { $gte:
 * page.createdAt }` to enforce this. A page missing `createdAt` on disk
 * (pre-`default: Date.now` legacy edge case) falls back to the epoch so the
 * bound never excludes rows it can't reason about worse than before this fix.
 * ─────────────────────────────────────────────────────────────────────
 *
 * ── Orphan handling (spec 未確定事項 1) + idempotent closure (reviewer #2) ──
 * A revision can end up impossible to resolve this way for two reasons: (a)
 * it deviated from the standard lifecycle before this migration first ran
 * (the interrupted-delete / raw-edit case above), or (b) the `createdAt`
 * bound correctly refuses to guess because it predates the current
 * occupant's existence. Such rows are never deleted and never assigned a
 * guessed id, and are reported via `ctx.logger.warn` with a bounded id
 * sample for manual follow-up. They remain visible only through the
 * pre-existing `path`-keyed accessors (`Revision.findRevisionList` etc.),
 * which this feature does not remove.
 *
 * They ARE, however, explicitly closed out with `page: null` (not left
 * `undefined`) once triaged. This distinction matters for `isPending`
 * (`{ page: { $exists: false } }`, which matches "field absent" but NOT
 * "field explicitly null"): without this closure, an install with even one
 * permanent orphan would probe `isPending` → true forever, and every boot
 * would re-run the stage, re-scan every page, and re-emit the warn log
 * (reviewer-caught, round 1) — `apply()`'s "not pending + already applied"
 * reconciliation branch (`runner.ts`) never gets to short-circuit. `page:
 * null` reads as "known, triaged, unresolved" to every consumer (the read
 * paths in `hono/handlers/revision.ts` already treat `!revision.page` —
 * covering both `undefined` and `null` — as fail-closed) while making the
 * *migration's own* probe settle to clean.
 * ─────────────────────────────────────────────────────────────────────
 */

const PAGE_BATCH_SIZE = 500;
const ORPHAN_SAMPLE_SIZE = 20;
const EPOCH = new Date(0);

export const revisionPageRefBackfill = defineMigration({
  id: 'revision-page-ref-backfill',
  fromVersion: '2.1',
  toVersion: '2.1',
  layer: 'boot',
  description: 'Backfill Revision.page (immutable Page ObjectId ref, DC-5)',

  /**
   * `Revision.page` is `index: true` (non-sparse) — the index does carry an
   * entry for documents where the field is absent (they key as BSON null,
   * same as an explicit `null`), but that alone does not make `{ $exists:
   * false }` a pure index-covered lookup: the planner still has to fetch
   * each candidate document to tell "field absent" apart from "field
   * explicitly null" before it can decide the predicate matches. In
   * practice this is a narrow index-bounded scan, not a full collection
   * scan, and — more importantly — this probe only runs at boot (not per
   * HTTP request), so the extra per-document check is immaterial.
   * `Revision.exists` avoids materialising a full document for the check.
   */
  isPending: async (ctx) => {
    const Revision = ctx.crowi.model('Revision') as RevisionModel;
    const legacy = await Revision.exists({ page: { $exists: false } });
    return legacy != null;
  },

  /**
   * Optional `plan` detail: count the remaining legacy rows. Not called at
   * boot — only `isPending` runs there.
   */
  detect: async (ctx) => {
    const Revision = ctx.crowi.model('Revision') as RevisionModel;
    const remaining = await Revision.countDocuments({ page: { $exists: false } }).exec();
    return {
      summary: `${remaining} legacy revision row(s) without page`,
      counts: { remaining },
    };
  },

  stages: [
    {
      name: 'backfill-page-ref',
      fn: async (ctx) => {
        if (ctx.dryRun) {
          return { name: 'backfill-page-ref', transformed: 0 };
        }
        const Page = ctx.crowi.model('Page');
        const Revision = ctx.crowi.model('Revision') as RevisionModel;

        let transformed = 0;
        let batch: { path: string; _id: Types.ObjectId; createdAt: Date }[] = [];

        // Flush the buffered pages as one `bulkWrite` round trip: one
        // `updateMany`-shaped op per page, scoped to `path` AND still
        // missing `page` AND created no earlier than the page itself (the
        // path-reuse safety bound — see the module doc comment). Idempotent
        // — a page whose revisions were already backfilled by a prior
        // partial run contributes a no-op.
        const flush = async (): Promise<void> => {
          if (batch.length === 0) return;
          const ops = batch.map(({ path, _id, createdAt }) => ({
            updateMany: {
              filter: { path, page: { $exists: false }, createdAt: { $gte: createdAt } },
              update: { $set: { page: _id } },
            },
          }));
          const result = await Revision.bulkWrite(ops, { ordered: false });
          transformed += result.modifiedCount;
          batch = [];
        };

        const cursor = Page.find({}, { _id: 1, path: 1, createdAt: 1 }).lean().cursor();
        try {
          for await (const raw of cursor) {
            const page = raw as { _id: Types.ObjectId; path: string; createdAt?: Date };
            batch.push({ path: page.path, _id: page._id, createdAt: page.createdAt ?? EPOCH });
            if (batch.length >= PAGE_BATCH_SIZE) {
              await flush();
            }
          }
          await flush();
        } finally {
          await cursor.close();
        }

        if (transformed > 0) {
          ctx.logger.info(`revision-page-ref-backfill: backfilled page ref on ${transformed} revision row(s)`);
        }

        // Standard-path deviations + createdAt-bound refusals (module doc
        // comment): report, never delete or guess an owner. Then close them
        // out with an explicit `page: null` so `isPending`'s `$exists:
        // false` probe stops matching them — without this, a permanent
        // orphan would keep the migration "pending" (and its stage
        // re-running, re-warning) on every future boot.
        const orphanFilter = { page: { $exists: false } };
        const orphanCount = await Revision.countDocuments(orphanFilter).exec();
        if (orphanCount > 0) {
          const orphanSample = await Revision.find(orphanFilter).select('_id path').limit(ORPHAN_SAMPLE_SIZE).lean().exec();
          const sampleIds = orphanSample.map((r) => String(r._id)).join(', ');
          ctx.logger.warn(
            `revision-page-ref-backfill: ${orphanCount} orphaned revision row(s) remain without a matching page (path did not resolve to any current page, or predates it) — manual review needed. Sample ids: ${sampleIds}`,
          );
          await Revision.updateMany(orphanFilter, { $set: { page: null } }).exec();
        }

        return { name: 'backfill-page-ref', transformed, stats: { orphanCount } };
      },
    },
  ],
});
