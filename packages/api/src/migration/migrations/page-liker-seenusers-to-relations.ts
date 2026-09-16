import { Types, type mongo } from 'mongoose';

import { defineMigration } from '../types';
import type { MigrationContext, MigrationStage, StageResult } from '../types';

/**
 * `page-liker-seenusers-to-relations` (preflight, blocking).
 *
 * Every crowi database up to and including alpha.17 stores Like and
 * "seen by" membership as `pages.liker` / `pages.seenUsers` ObjectId
 * arrays. The runtime read/write path was moved to the independent
 * `likes` / `seens` collections and both fields were dropped from the
 * `Page` schema, but a document's stored fields survive a schema change —
 * every pre-cutover database still has the legacy arrays on
 * disk. This migration copies them forward once and removes them, so it is
 * `blocking`: before it runs, `likes` / `seens` are simply missing the rows
 * every existing Like / seen-by relation, and — because `Like` / `Seen`
 * register with `autoIndex: false` — nothing else in the codebase ever
 * builds their `{page,user}` unique index (see `ensureUniqueIndex()` on
 * both models). Booting against unmigrated data risks concurrent writers
 * racing an absent index into duplicate rows.
 *
 * ── Four stages, each independently re-runnable ─────────────────────────
 * `prepare-target-index` → `copy-relations` → `verify-relations` →
 * `unset-legacy-fields`. The runner (`MigrationRunner.apply`, `runner.ts`)
 * evaluates `isPending` once per `apply` call and only proceeds through
 * stages when pending; it does not roll back a partially-completed run. A
 * process kill, SIGINT (which only takes effect between stages — see
 * `MigrationRunnerCore`), or an operator interruption between stages 2 and 4
 * leaves `pages.liker` / `pages.seenUsers` on disk, so `isPending` is still
 * `true` and the next `apply` resumes: stage 1 is idempotent against an
 * already-built index, stage 2's upsert-only writes are idempotent against
 * rows a prior partial run already copied, and stage 4's `$unset` is a
 * single flat write with no partial-application concept of its own.
 *
 * ── Upsert-only asymmetry (stage 2) ──────────────────────────────────────
 * Copy never deletes a target row that has no matching source — only the
 * inverse (upsert a source row missing from the target). If the operator's
 * maintenance window was NOT airtight (a writer stayed live and a user
 * liked/unliked a page through the new binary while migration ran), the
 * live write already created a `likes` row this migration's source
 * snapshot never saw. Reconciling target-to-source would delete that row —
 * an unrecoverable loss of a real, current Like. Failing to delete a stale
 * row an operator can undo themselves (unlike the page again) is the
 * strictly safer failure mode, so copy is asymmetric by design.
 *
 * ── Diagnosing stage 1 duplicates without branching on `error.code` ─────
 * `Like.ensureUniqueIndex()` / `Seen.ensureUniqueIndex()` re-verify the
 * index catalog after `createIndexes()` — they do not promise to
 * propagate the driver's raw E11000 error unchanged, so branching on
 * `err.code === 11000` here is not reliable.
 * Instead, ANY `ensureUniqueIndex()` failure triggers a read-only
 * `{page,user}` duplicate-group aggregation against both target
 * collections; a duplicate found there is reported as the (sanitized,
 * bounded) `PageRelationMigrationError`, and the absence of one means the
 * index build failed for an unrelated reason — the original error is
 * rethrown untouched (type and message), including when the diagnostic
 * aggregation itself throws (its failure is logged at `debug` and never
 * allowed to shadow the real cause).
 */

export const PAGE_BATCH_SIZE = 500;
const SAMPLE_LIMIT = 20;
const OBJECT_ID_HEX_RE = /^[0-9a-fA-F]{24}$/;

type ObjectId = mongo.ObjectId;

/** Read-only filter shared by `isPending`, `detect`, and every stage — a Page carries at least one legacy field. */
export const LEGACY_FIELD_FILTER = { $or: [{ liker: { $exists: true } }, { seenUsers: { $exists: true } }] };

/** Per-page normalization result for one legacy field (`liker` or `seenUsers`). */
export interface NormalizedLegacyUserIds {
  userIds: ObjectId[];
  inputElements: number;
  droppedElements: number;
  deduplicatedElements: number;
  nonArrayLegacyFields: number;
}

export type RelationIssueKind = 'duplicate-like' | 'duplicate-seen' | 'missing-like' | 'missing-seen';

/** One bounded, sanitized sample row — the only fields an operator-facing report allows. */
export interface RelationIssueSample {
  kind: RelationIssueKind;
  pageId: string;
  userId: string;
  count: number;
}

export interface RelationIssueStats {
  duplicateLikes: number;
  duplicateSeens: number;
  missingLikes: number;
  missingSeens: number;
  samples: RelationIssueSample[];
}

/** Thrown by stage 1 (duplicates) and stage 3 (missing rows). `stats` is a programmatic mirror of `message` — never the only place the detail lives. */
export class PageRelationMigrationError extends Error {
  readonly stats: RelationIssueStats;

  constructor(prefix: string, stats: RelationIssueStats) {
    super(formatRelationIssueMessage(prefix, stats));
    this.name = 'PageRelationMigrationError';
    this.stats = stats;
  }
}

function formatRelationIssueMessage(prefix: string, stats: RelationIssueStats): string {
  const totals = `duplicateLikes=${stats.duplicateLikes}, duplicateSeens=${stats.duplicateSeens}, missingLikes=${stats.missingLikes}, missingSeens=${stats.missingSeens}`;
  const sampleText = stats.samples.length === 0 ? 'none' : stats.samples.map((s) => `${s.kind} page=${s.pageId} user=${s.userId} count=${s.count}`).join('; ');
  return `${prefix}: ${totals}. Samples (max ${SAMPLE_LIMIT} across all categories): ${sampleText}`;
}

/** Accepts a `mongo.ObjectId` instance or a 24-hex string; everything else is dropped. */
function toValidObjectId(value: unknown): ObjectId | null {
  if (value instanceof Types.ObjectId) return value;
  if (typeof value === 'string' && OBJECT_ID_HEX_RE.test(value)) return new Types.ObjectId(value);
  return null;
}

/**
 * A non-array present field is treated as one input element (matches the
 * current visible behaviour: Mongoose casts a scalar into a one-element
 * array on hydration, so that Page's `likerCount` reads 1 today).
 */
export function normalizeLegacyUserIds(raw: unknown, fieldPresent: boolean): NormalizedLegacyUserIds {
  if (!fieldPresent) {
    return { userIds: [], inputElements: 0, droppedElements: 0, deduplicatedElements: 0, nonArrayLegacyFields: 0 };
  }
  const isArray = Array.isArray(raw);
  const elements: unknown[] = isArray ? raw : [raw];
  const seen = new Map<string, ObjectId>();
  let droppedElements = 0;
  let deduplicatedElements = 0;
  for (const el of elements) {
    const id = toValidObjectId(el);
    if (id == null) {
      droppedElements += 1;
      continue;
    }
    const key = id.toHexString();
    if (seen.has(key)) {
      deduplicatedElements += 1;
      continue;
    }
    seen.set(key, id);
  }
  return {
    userIds: [...seen.values()],
    inputElements: elements.length,
    droppedElements,
    deduplicatedElements,
    nonArrayLegacyFields: isArray ? 0 : 1,
  };
}

type NormalizationTotals = Omit<NormalizedLegacyUserIds, 'userIds'>;

function emptyTotals(): NormalizationTotals {
  return { inputElements: 0, droppedElements: 0, deduplicatedElements: 0, nonArrayLegacyFields: 0 };
}

function addTotals(totals: NormalizationTotals, n: NormalizedLegacyUserIds): void {
  totals.inputElements += n.inputElements;
  totals.droppedElements += n.droppedElements;
  totals.deduplicatedElements += n.deduplicatedElements;
  totals.nonArrayLegacyFields += n.nonArrayLegacyFields;
}

interface NormalizedPageRow {
  pageId: ObjectId;
  like: NormalizedLegacyUserIds;
  seen: NormalizedLegacyUserIds;
}

function normalizePageRow(raw: Record<string, unknown>): NormalizedPageRow {
  return {
    pageId: raw._id as ObjectId,
    like: normalizeLegacyUserIds(raw.liker, Object.hasOwn(raw, 'liker')),
    seen: normalizeLegacyUserIds(raw.seenUsers, Object.hasOwn(raw, 'seenUsers')),
  };
}

function legacySourceCursor(pages: mongo.Collection) {
  return pages.find(LEGACY_FIELD_FILTER, { projection: { _id: 1, liker: 1, seenUsers: 1 }, readPreference: 'primary' }).batchSize(PAGE_BATCH_SIZE);
}

// ── Stage 1: prepare-target-index ──────────────────────────────────────

interface DuplicateGroup {
  page: ObjectId;
  user: ObjectId;
  count: number;
}

/** `{page,user}` groups with more than one row — read-only, primary, `allowDiskUse`. */
async function findDuplicateGroups(collection: mongo.Collection): Promise<DuplicateGroup[]> {
  const rows = await collection
    .aggregate<{ _id: { page: ObjectId; user: ObjectId }; n: number }>(
      [{ $group: { _id: { page: '$page', user: '$user' }, n: { $sum: 1 } } }, { $match: { n: { $gt: 1 } } }],
      { allowDiskUse: true, readPreference: 'primary' },
    )
    .toArray();
  return rows.map((r) => ({ page: r._id.page, user: r._id.user, count: r.n }));
}

function buildDuplicateStats(likeDupes: DuplicateGroup[], seenDupes: DuplicateGroup[]): RelationIssueStats {
  const samples: RelationIssueSample[] = [];
  for (const d of likeDupes) {
    if (samples.length >= SAMPLE_LIMIT) break;
    samples.push({ kind: 'duplicate-like', pageId: d.page.toString(), userId: d.user.toString(), count: d.count });
  }
  for (const d of seenDupes) {
    if (samples.length >= SAMPLE_LIMIT) break;
    samples.push({ kind: 'duplicate-seen', pageId: d.page.toString(), userId: d.user.toString(), count: d.count });
  }
  return { duplicateLikes: likeDupes.length, duplicateSeens: seenDupes.length, missingLikes: 0, missingSeens: 0, samples };
}

/**
 * Build the two target unique indexes; on ANY failure, diagnose via a
 * read-only duplicate aggregation rather than branching on `error.code`
 * (see module doc comment). Never called in dry-run — the caller returns a
 * static planned-call-count stat instead.
 */
async function ensureIndexOrDiagnoseDuplicates(ctx: MigrationContext): Promise<void> {
  const Like = ctx.crowi.model('Like');
  const Seen = ctx.crowi.model('Seen');
  try {
    await Like.ensureUniqueIndex();
    await Seen.ensureUniqueIndex();
  } catch (err) {
    let likeDupes: DuplicateGroup[] = [];
    let seenDupes: DuplicateGroup[] = [];
    try {
      likeDupes = await findDuplicateGroups(Like.collection);
      seenDupes = await findDuplicateGroups(Seen.collection);
    } catch (diagErr) {
      const message = diagErr instanceof Error ? diagErr.message : String(diagErr);
      ctx.logger.debug(`page-liker-seenusers-to-relations: duplicate diagnostic aggregation failed, rethrowing the original index error: ${message}`);
      throw err;
    }
    if (likeDupes.length === 0 && seenDupes.length === 0) {
      // Not a duplicate-key failure — the original error's type and message are preserved.
      throw err;
    }
    throw new PageRelationMigrationError(
      'page-liker-seenusers-to-relations: duplicate {page,user} rows are blocking the unique index build',
      buildDuplicateStats(likeDupes, seenDupes),
    );
  }
}

const prepareTargetIndex: MigrationStage = {
  name: 'prepare-target-index',
  fn: async (ctx): Promise<StageResult> => {
    if (ctx.dryRun) {
      return { name: 'prepare-target-index', transformed: 0, stats: { indexEnsureCallsPlanned: 2 } };
    }
    await ensureIndexOrDiagnoseDuplicates(ctx);
    return { name: 'prepare-target-index', transformed: 0 };
  },
};

// ── Stage 2: copy-relations ────────────────────────────────────────────

type UpsertOp = mongo.AnyBulkWriteOperation<mongo.Document>;

function buildUpsertOps(pageId: ObjectId, userIds: ObjectId[]): UpsertOp[] {
  return userIds.map((userId) => ({
    updateOne: {
      filter: { page: pageId, user: userId },
      update: { $setOnInsert: { createdAt: null } },
      upsert: true,
    },
  }));
}

/** `err.result.getWriteConcernError()` is the ONLY way to observe a write-concern error alongside `writeErrors` — `.err` is not set in that shape. */
function isE11000OnlyBulkWriteError(err: unknown): err is { result: { upsertedCount: number; getWriteConcernError: () => unknown } } {
  if (typeof err !== 'object' || err === null) return false;
  const e = err as Record<string, unknown>;
  if (e.name !== 'MongoBulkWriteError') return false;
  const writeErrors = e.writeErrors;
  if (!Array.isArray(writeErrors) || writeErrors.length === 0) return false;
  const allE11000 = writeErrors.every((we) => (we as { code?: number } | null)?.code === 11000);
  if (!allE11000) return false;
  const result = e.result as { getWriteConcernError?: () => unknown; upsertedCount?: unknown } | undefined;
  if (result == null || typeof result.getWriteConcernError !== 'function') return false;
  if (typeof result.upsertedCount !== 'number' || Number.isNaN(result.upsertedCount)) return false;
  return result.getWriteConcernError() == null;
}

/** Upsert-only bulk write, tolerant of an all-E11000 (no write-concern error) partial failure. Empty `ops` never calls `bulkWrite`. */
async function bulkWriteTolerant(collection: mongo.Collection, ops: UpsertOp[]): Promise<number> {
  if (ops.length === 0) return 0;
  try {
    const result = await collection.bulkWrite(ops, { ordered: false });
    return result.upsertedCount;
  } catch (err) {
    if (isE11000OnlyBulkWriteError(err)) {
      return err.result.upsertedCount;
    }
    throw err;
  }
}

const copyRelations: MigrationStage = {
  name: 'copy-relations',
  fn: async (ctx): Promise<StageResult> => {
    const pages = ctx.db.collection('pages');

    if (ctx.dryRun) {
      let likeUpsertAttempts = 0;
      let seenUpsertAttempts = 0;
      const likeNormalization = emptyTotals();
      const seenNormalization = emptyTotals();
      for await (const raw of legacySourceCursor(pages)) {
        const { like, seen } = normalizePageRow(raw as Record<string, unknown>);
        likeUpsertAttempts += like.userIds.length;
        seenUpsertAttempts += seen.userIds.length;
        addTotals(likeNormalization, like);
        addTotals(seenNormalization, seen);
      }
      return {
        name: 'copy-relations',
        transformed: 0,
        stats: { likeUpsertAttempts, seenUpsertAttempts, likeNormalization, seenNormalization },
      };
    }

    const Like = ctx.crowi.model('Like').collection;
    const Seen = ctx.crowi.model('Seen').collection;

    const total = await pages.countDocuments(LEGACY_FIELD_FILTER);
    ctx.progress.setTotal(total);

    let pagesScanned = 0;
    let likesUpserted = 0;
    let seensUpserted = 0;
    const likeNormalization = emptyTotals();
    const seenNormalization = emptyTotals();

    let likeOps: UpsertOp[] = [];
    let seenOps: UpsertOp[] = [];
    let batchCount = 0;

    const flush = async (): Promise<void> => {
      likesUpserted += await bulkWriteTolerant(Like, likeOps);
      seensUpserted += await bulkWriteTolerant(Seen, seenOps);
      likeOps = [];
      seenOps = [];
    };

    for await (const raw of legacySourceCursor(pages)) {
      const { pageId, like, seen } = normalizePageRow(raw as Record<string, unknown>);
      addTotals(likeNormalization, like);
      addTotals(seenNormalization, seen);
      likeOps.push(...buildUpsertOps(pageId, like.userIds));
      seenOps.push(...buildUpsertOps(pageId, seen.userIds));

      pagesScanned += 1;
      batchCount += 1;
      ctx.progress.increment();
      if (batchCount >= PAGE_BATCH_SIZE) {
        await flush();
        batchCount = 0;
      }
    }
    await flush();

    return {
      name: 'copy-relations',
      transformed: likesUpserted + seensUpserted,
      stats: { pagesScanned, likesUpserted, seensUpserted, likeNormalization, seenNormalization },
    };
  },
};

// ── Stage 3: verify-relations ──────────────────────────────────────────

async function actualKeySet(collection: mongo.Collection, pageIds: ObjectId[]): Promise<Set<string>> {
  const rows = await collection
    .find<{ page: ObjectId; user: ObjectId }>({ page: { $in: pageIds } }, { projection: { page: 1, user: 1 }, readPreference: 'primary' })
    .toArray();
  const out = new Set<string>();
  for (const row of rows) {
    out.add(`${row.page.toString()}:${row.user.toString()}`);
  }
  return out;
}

const verifyRelations: MigrationStage = {
  name: 'verify-relations',
  fn: async (ctx): Promise<StageResult> => {
    const pages = ctx.db.collection('pages');

    if (ctx.dryRun) {
      let likeRelationsToVerify = 0;
      let seenRelationsToVerify = 0;
      for await (const raw of legacySourceCursor(pages)) {
        const { like, seen } = normalizePageRow(raw as Record<string, unknown>);
        likeRelationsToVerify += like.userIds.length;
        seenRelationsToVerify += seen.userIds.length;
      }
      return { name: 'verify-relations', transformed: 0, stats: { likeRelationsToVerify, seenRelationsToVerify } };
    }

    const Like = ctx.crowi.model('Like').collection;
    const Seen = ctx.crowi.model('Seen').collection;

    let pagesVerified = 0;
    let missingLikes = 0;
    let missingSeens = 0;
    const samples: RelationIssueSample[] = [];

    let batch: NormalizedPageRow[] = [];
    const flushBatch = async (): Promise<void> => {
      if (batch.length === 0) return;
      const pageIds = batch.map((row) => row.pageId);
      const [likeActual, seenActual] = await Promise.all([actualKeySet(Like, pageIds), actualKeySet(Seen, pageIds)]);
      for (const row of batch) {
        for (const userId of row.like.userIds) {
          const key = `${row.pageId.toString()}:${userId.toString()}`;
          if (!likeActual.has(key)) {
            missingLikes += 1;
            if (samples.length < SAMPLE_LIMIT) {
              samples.push({ kind: 'missing-like', pageId: row.pageId.toString(), userId: userId.toString(), count: 1 });
            }
          }
        }
        for (const userId of row.seen.userIds) {
          const key = `${row.pageId.toString()}:${userId.toString()}`;
          if (!seenActual.has(key)) {
            missingSeens += 1;
            if (samples.length < SAMPLE_LIMIT) {
              samples.push({ kind: 'missing-seen', pageId: row.pageId.toString(), userId: userId.toString(), count: 1 });
            }
          }
        }
      }
      pagesVerified += batch.length;
      batch = [];
    };

    for await (const raw of legacySourceCursor(pages)) {
      batch.push(normalizePageRow(raw as Record<string, unknown>));
      if (batch.length >= PAGE_BATCH_SIZE) {
        await flushBatch();
      }
    }
    await flushBatch();

    if (missingLikes > 0 || missingSeens > 0) {
      throw new PageRelationMigrationError('page-liker-seenusers-to-relations: relation rows are missing from the target after copy', {
        duplicateLikes: 0,
        duplicateSeens: 0,
        missingLikes,
        missingSeens,
        samples,
      });
    }

    return { name: 'verify-relations', transformed: 0, stats: { pagesVerified, missingLikes: 0, missingSeens: 0 } };
  },
};

// ── Stage 4: unset-legacy-fields ───────────────────────────────────────

const unsetLegacyFields: MigrationStage = {
  name: 'unset-legacy-fields',
  fn: async (ctx): Promise<StageResult> => {
    const pages = ctx.db.collection('pages');

    if (ctx.dryRun) {
      const pagesToUnset = await pages.countDocuments(LEGACY_FIELD_FILTER);
      return { name: 'unset-legacy-fields', transformed: 0, stats: { pagesToUnset } };
    }

    const result = await pages.updateMany(LEGACY_FIELD_FILTER, { $unset: { liker: '', seenUsers: '' } });
    return { name: 'unset-legacy-fields', transformed: result.modifiedCount, stats: { pagesUnset: result.modifiedCount } };
  },
};

// ── isPending / detect ─────────────────────────────────────────────────

/**
 * Deliberately deviates from the "no full-collection scan" rule every other
 * `isPending` follows (`types.ts` doc comment): it stops at the first match
 * when pending, and only walks the whole `pages` collection once boot has
 * clean data — one bounded scan per boot, on a dataset sized in the
 * thousands to tens of thousands of Page rows, not per-request.
 * Primary-pinned so replica lag can never present unmigrated data as clean.
 */
async function isPending(ctx: MigrationContext): Promise<boolean> {
  const pages = ctx.db.collection('pages');
  const found = await pages.findOne(LEGACY_FIELD_FILTER, { projection: { _id: 1 }, readPreference: 'primary' });
  return found != null;
}

/** Full-scan `plan` preview. Primary-pinned (same replica-lag rationale as `isPending`) but streamed rather than materialized into memory at once. */
async function detect(ctx: MigrationContext) {
  const pages = ctx.db.collection('pages');
  const cursor = pages.find(LEGACY_FIELD_FILTER, { projection: { _id: 1, liker: 1, seenUsers: 1 }, readPreference: 'primary' });

  const counts = {
    pages: 0,
    likerElements: 0,
    seenUserElements: 0,
    validLikeRelations: 0,
    validSeenRelations: 0,
    droppedLikerElements: 0,
    droppedSeenUserElements: 0,
    deduplicatedLikerElements: 0,
    deduplicatedSeenUserElements: 0,
    nonArrayLikerFields: 0,
    nonArraySeenUsersFields: 0,
  };

  for await (const raw of cursor) {
    const { like, seen } = normalizePageRow(raw as Record<string, unknown>);
    counts.pages += 1;
    counts.likerElements += like.inputElements;
    counts.seenUserElements += seen.inputElements;
    counts.validLikeRelations += like.userIds.length;
    counts.validSeenRelations += seen.userIds.length;
    counts.droppedLikerElements += like.droppedElements;
    counts.droppedSeenUserElements += seen.droppedElements;
    counts.deduplicatedLikerElements += like.deduplicatedElements;
    counts.deduplicatedSeenUserElements += seen.deduplicatedElements;
    counts.nonArrayLikerFields += like.nonArrayLegacyFields;
    counts.nonArraySeenUsersFields += seen.nonArrayLegacyFields;
  }

  const likerSummary = `liker ${counts.likerElements} element(s) -> ${counts.validLikeRelations} valid (${counts.droppedLikerElements} dropped, ${counts.deduplicatedLikerElements} deduplicated, ${counts.nonArrayLikerFields} non-array field(s))`;
  const seenUsersSummary = `seenUsers ${counts.seenUserElements} element(s) -> ${counts.validSeenRelations} valid (${counts.droppedSeenUserElements} dropped, ${counts.deduplicatedSeenUserElements} deduplicated, ${counts.nonArraySeenUsersFields} non-array field(s))`;

  return {
    summary: `${counts.pages} page(s) with legacy liker/seenUsers: ${likerSummary}; ${seenUsersSummary}`,
    counts,
  };
}

export const pageLikerSeenUsersToRelations = defineMigration({
  id: 'page-liker-seenusers-to-relations',
  fromVersion: '1.x',
  toVersion: '2.0',
  layer: 'preflight',
  severity: 'blocking',
  description: 'Migrate Page liker/seenUsers to relation collections',
  isPending,
  detect,
  stages: [prepareTargetIndex, copyRelations, verifyRelations, unsetLegacyFields],
});
