import type { Types } from 'mongoose';
import type Crowi from 'src/crowi';
import type { MigrationContext } from 'src/migration/types';
import type { RebuildRunner } from 'src/migration/rebuild-runner';
import { metadataToRevisionMeta, type RevisionModel } from 'src/models/revision';
import type { PageModel } from 'src/models/page';
import { RENDERER_PIPELINE_VERSION } from 'src/renderer/version';
import { applyRevisionAstBudget } from './revision-size-guard';

/**
 * RFC-0023 §15 — `crowi-admin rebuild rendered-ast`.
 *
 * Backfills `Revision.renderedAst` (+ `rendererVersion` + `meta`) for
 * every page's **current revision** whose stored AST predates the
 * running pipeline. Distinct from `rebuild renderer`
 * (`util/rebuild-renderer.ts`): that (unimplemented) task's contract is
 * `PluginRenderCache` regeneration and it never touches `Revision`.
 *
 * **Unified eligibility predicate** (single definition; scan
 * prefiltering, per-item classification, progress counting and the
 * completion check all evaluate THIS): the current revision's
 * `rendererVersion` is undefined, or semver-older than the
 * `capturedTargetVersion` (captured ONCE at task start from
 * `RENDERER_PIPELINE_VERSION` — never re-read mid-run, or rows this run
 * itself stamped could be miscounted as remaining). `renderedAst`
 * absence is covered naturally: an AST-less revision has no (or an old)
 * `rendererVersion` and the read path treats it as stale either way.
 * The Mongo `$ne` scan is a COARSE PREFILTER only — semver ordering is
 * not expressible in a Mongo filter, so a revision stamped NEWER than
 * this binary's version stays in the scan but is never eligible (and
 * never blocks completion).
 *
 * **Update predicate**: compare-and-set on the observed
 * `rendererVersion` plus the monotonic version guard ("never write when
 * the observed version is >= my target") — an old-binary worker can
 * therefore never downgrade a newer replica's output, and two
 * concurrent workers can never ping-pong (`matchedCount === 0` is a
 * benign no-op skip, not a lost update; the idempotent predicate
 * re-collects genuinely-stale rows on the next run). An
 * `observedVersion === undefined` CAS matches on
 * `{ $exists: false }` — Mongoose omits undefined fields entirely, so
 * an equality filter against undefined would never match.
 *
 * **Snapshot semantics**: targets are "the revisions that were current
 * at scan time". A save that supersedes a target mid-run is harmless —
 * the write only improves what the history view serves for that
 * revision, and the NEW current revision was written by
 * `prepareRevision` with the new pipeline already, so `Page.revision`
 * is deliberately NOT re-checked at write time.
 *
 * **Completion protocol** (§15 — operator-facing, also documented in
 * the admin guide): while ANY old-version api replica is still
 * routable, its saves keep minting old-version current revisions that a
 * finished run cannot have seen. Completion may only be declared after
 * (a) confirming every replica runs the new version, then (b) one final
 * re-run reports 0 eligible remaining. The task is idempotent, so the
 * final re-run costs only the residual row count.
 *
 * **Deployment note**: real-write execution belongs to the rollout step
 * right after deploying a `RENDERER_PIPELINE_VERSION` bump. Running
 * with writes BEFORE that deploy would still re-render every
 * `rendererVersion`-less legacy revision — pre-deploy verification must
 * use `--dry-run` only.
 */

export interface RenderedAstRebuildSummary {
  /** Pages whose current revision the coarse `$ne` prefilter surfaced. */
  scanned: number;
  /** Rows the unified predicate classified as eligible at visit time. */
  eligible: number;
  written: number;
  /** Rows the monotonic guard / CAS skipped (already stamped by a newer/concurrent worker). */
  skipped: number;
  /** Eligible rows remaining after the run (0 on a completed run; == eligible on dry-run). */
  remainingEligible: number;
  targetVersion: string;
  dryRun: boolean;
}

interface ScanTarget {
  pageId: Types.ObjectId;
  path: string;
  revisionId: Types.ObjectId;
}

interface LeanRevisionRow {
  _id: Types.ObjectId;
  rendererVersion?: string;
  body?: string;
  yjsUpdate?: Buffer;
}

function parseSemver(version: string): [number, number, number] | null {
  const match = /^(\d+)\.(\d+)\.(\d+)/.exec(version);
  if (!match) return null;
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

/** a >= b. Unparseable `a` counts as older (gets rebuilt); unparseable `b` cannot happen (it's our own constant). */
function semverGte(a: string, b: string): boolean {
  const pa = parseSemver(a);
  const pb = parseSemver(b);
  if (!pa || !pb) return false;
  for (let i = 0; i < 3; i++) {
    if (pa[i] > pb[i]) return true;
    if (pa[i] < pb[i]) return false;
  }
  return true;
}

/** The unified eligibility predicate (see module doc comment). */
function isEligible(observedVersion: string | undefined, capturedTargetVersion: string): boolean {
  if (observedVersion === undefined) return true;
  return !semverGte(observedVersion, capturedTargetVersion);
}

const SCAN_CHUNK = 500;

export async function runRenderedAstRebuild(crowi: Crowi, ctx: MigrationContext, runner: RebuildRunner): Promise<RenderedAstRebuildSummary> {
  // Captured ONCE — scan, per-item classification, CAS and the
  // completion recount all reference this same value.
  const capturedTargetVersion = RENDERER_PIPELINE_VERSION;
  const Page = crowi.model('Page') as unknown as PageModel;
  const Revision = crowi.model('Revision') as unknown as RevisionModel;

  const targets = await collectPrefilteredTargets(Page, Revision, capturedTargetVersion);

  let eligible = 0;
  let written = 0;
  let skipped = 0;

  await runner.mapBounded(targets, async (target) => {
    ctx.progress.setLabel(`rendered-ast ${target.path}`);
    const revision = await Revision.findById(target.revisionId).select('rendererVersion body meta yjsUpdate').lean<LeanRevisionRow | null>().exec();
    if (!revision) return;
    const observedVersion = revision.rendererVersion;
    // Monotonic version guard — identical to the unified predicate, so
    // a row skipped here is also never counted as "remaining".
    if (!isEligible(observedVersion, capturedTargetVersion)) return;
    eligible += 1;
    if (ctx.dryRun) {
      ctx.progress.increment();
      return;
    }

    // `mode: 'save'` + system actor + the owning pageId are REQUIRED:
    // mention resolution only runs on the save mode, dispatch needs the
    // page identity, and admission control needs an actor — anything
    // else would persist an AST that diverges from what the save path
    // produces for the same body (§15).
    const body = revision.body ?? '';
    const { metadata, renderedAst } = await crowi.getRenderer().runRender(body, {
      mode: 'save',
      pageId: target.pageId.toString(),
      actor: { kind: 'system' },
    });
    const meta = metadataToRevisionMeta(metadata);
    // Same whole-document budget helper as `prepareRevision` — a
    // backfill that wrote larger ASTs than the save path accepts would
    // make those pages unsavable on their next edit (§10/§15).
    const guarded = applyRevisionAstBudget({ renderedAst, body, meta, yjsUpdateBytes: revision.yjsUpdate?.byteLength }, (message) =>
      ctx.logger.warn(`${message} (path=${target.path})`),
    );

    const filter =
      observedVersion === undefined
        ? { _id: target.revisionId, rendererVersion: { $exists: false as const } }
        : { _id: target.revisionId, rendererVersion: observedVersion };
    // `meta` is co-written in the SAME $set: the read path ties the toc
    // source to the AST source (`computeRevisionRenderArtifactsAsync`'s
    // stored-wins merge) — stamping only the AST + version would make
    // the next read pair the NEW AST with the OLD toc and break TOC
    // click / scroll-spy (§15).
    const res = await Revision.updateOne(filter, {
      $set: {
        renderedAst: guarded.renderedAst,
        rendererVersion: capturedTargetVersion,
        meta,
      },
    }).exec();
    if (res.matchedCount === 0) {
      // Another worker stamped it first — benign no-op (see doc comment).
      skipped += 1;
    } else {
      written += 1;
    }
    ctx.progress.increment();
  });

  // Completion check = the unified predicate over a fresh scan, NOT the
  // `$ne` hit count (newer-version rows stay in the `$ne` scan forever
  // but are never eligible).
  const remainingEligible = await countRemainingEligible(Page, Revision, capturedTargetVersion);

  return {
    scanned: targets.length,
    eligible,
    written,
    skipped,
    remainingEligible: ctx.dryRun ? eligible : remainingEligible,
    targetVersion: capturedTargetVersion,
    dryRun: ctx.dryRun,
  };
}

/** Coarse `$ne` prefilter over every page's current revision (see module doc comment). */
async function collectPrefilteredTargets(Page: PageModel, Revision: RevisionModel, capturedTargetVersion: string): Promise<ScanTarget[]> {
  const pages = (await Page.find({ revision: { $ne: null } })
    .select('_id path revision')
    .lean()
    .exec()) as unknown as Array<{ _id: Types.ObjectId; path: string; revision?: Types.ObjectId | null }>;

  const byRevisionId = new Map<string, { pageId: Types.ObjectId; path: string; revisionId: Types.ObjectId }>();
  for (const page of pages) {
    if (!page.revision) continue;
    byRevisionId.set(String(page.revision), { pageId: page._id, path: page.path, revisionId: page.revision });
  }

  const targets: ScanTarget[] = [];
  const ids = Array.from(byRevisionId.keys());
  for (let i = 0; i < ids.length; i += SCAN_CHUNK) {
    const chunk = ids.slice(i, i + SCAN_CHUNK);
    const rows = (await Revision.find({
      _id: { $in: chunk },
      $or: [{ rendererVersion: { $exists: false } }, { rendererVersion: { $ne: capturedTargetVersion } }],
    })
      .select('_id')
      .lean()
      .exec()) as unknown as Array<{ _id: Types.ObjectId }>;
    for (const row of rows) {
      const target = byRevisionId.get(String(row._id));
      if (target) targets.push(target);
    }
  }
  return targets;
}

async function countRemainingEligible(Page: PageModel, Revision: RevisionModel, capturedTargetVersion: string): Promise<number> {
  const targets = await collectPrefilteredTargets(Page, Revision, capturedTargetVersion);
  if (targets.length === 0) return 0;
  let remaining = 0;
  for (let i = 0; i < targets.length; i += SCAN_CHUNK) {
    const chunk = targets.slice(i, i + SCAN_CHUNK);
    const rows = (await Revision.find({ _id: { $in: chunk.map((t) => t.revisionId) } })
      .select('_id rendererVersion')
      .lean()
      .exec()) as unknown as Array<{ _id: Types.ObjectId; rendererVersion?: string }>;
    for (const row of rows) {
      if (isEligible(row.rendererVersion, capturedTargetVersion)) remaining += 1;
    }
  }
  return remaining;
}
