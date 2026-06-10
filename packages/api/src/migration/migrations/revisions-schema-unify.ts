import type { RevisionModel } from 'src/models/revision';

import { defineMigration } from '../types';

/**
 * RFC-0008 §10.3 step5 — `revisions-schema-unify`.
 *
 * Backfills `revision.type = 'snapshot'` onto v1.x revisions written before
 * the field existed. `Revision.type` (`'snapshot' | 'incremental'`) was added
 * by RFC-0003 and the read path already treats `undefined` as `'snapshot'`
 * for back-compat. Phase 6 is therefore NOT a new-field addition — it is a
 * one-time backfill of the existing field plus closing the write source so
 * the value is always present going forward.
 *
 * Closing the write source: `models/revision.ts` now declares
 * `type: { default: 'snapshot' }`, so every newly written revision — even on
 * the HTTP API path (`Page.createPage` / `Page.updatePage`), which never
 * passes an explicit `type` — lands with a concrete value. Without that
 * default this migration would re-pend on every fresh revision and, as a boot
 * migration, permanently block boot (the Phase 3 wikilink lesson).
 *
 * ── RFC LAYER DEVIATION ──────────────────────────────────────────────
 * RFC-0008 §10.3 / Appendix A classify this as a `preflight` migration.
 * We deliberately run it as `layer: 'boot'` instead: once the schema
 * `default: 'snapshot'` closes the write source, the transform reduces to a
 * single idempotent `updateMany({ type: null }, ...)` backfill — structurally
 * identical to `page-status-default` (also boot). It is cheap, index-backed,
 * and non-destructive, so boot-auto is the right fit. This deviation is noted
 * in TODO.md as well.
 * ─────────────────────────────────────────────────────────────────────
 *
 * Scope: `type` ONLY. `contributors` is left untouched (v1.x has no `savedBy`
 * either; we do not fabricate collaboration history, and the wire format
 * already omits an undefined `contributors`). `renderedAst` is the
 * `rebuild renderer` task's responsibility per RFC-0008.
 */
export const revisionsSchemaUnify = defineMigration({
  id: 'revisions-schema-unify',
  fromVersion: '2.0',
  toVersion: '2.1',
  layer: 'boot',
  description: 'Unify revision schema (backfill type:snapshot)',

  /**
   * Cheap, index-backed probe: `Revision.type` is declared `index: true`
   * (models/revision.ts), so `findOne({ type: null })` is covered by that
   * index and never scans the collection. `{ type: null }` matches both a
   * missing field and an explicit `null` in MongoDB query semantics, so a
   * single condition covers every legacy shape. Pending iff at least one
   * legacy revision is still missing a type. After apply (and because new
   * revisions are filled by the schema `default`) this stays false — no
   * permanent boot block.
   */
  isPending: async (ctx) => {
    const Revision = ctx.crowi.model('Revision') as RevisionModel;
    const legacy = await Revision.findOne({ type: null }).select('_id').lean().exec();
    return legacy != null;
  },

  /**
   * Optional `plan` detail: count the remaining legacy rows. Not called at
   * boot — only `isPending` runs there. Index-backed count on `type`.
   */
  detect: async (ctx) => {
    const Revision = ctx.crowi.model('Revision') as RevisionModel;
    const remaining = await Revision.countDocuments({ type: null }).exec();
    return {
      summary: `${remaining} legacy revision row(s) without type`,
      counts: { remaining },
    };
  },

  stages: [
    {
      name: 'backfill-type',
      fn: async (ctx) => {
        if (ctx.dryRun) {
          return { name: 'backfill-type', transformed: 0 };
        }
        const Revision = ctx.crowi.model('Revision') as RevisionModel;
        const result = await Revision.updateMany({ type: null }, { $set: { type: 'snapshot' } });
        const modified = (result as { modifiedCount?: number }).modifiedCount ?? 0;
        if (modified > 0) {
          ctx.logger.info(`revisions-schema-unify: backfilled type='snapshot' on ${modified} legacy revision row(s)`);
        }
        return { name: 'backfill-type', transformed: modified };
      },
    },
  ],
});
