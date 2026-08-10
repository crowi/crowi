/**
 * feature-image-derivative-optimization Phase 3 §11 — the core of
 * `crowi-admin rebuild attachment-display-derivatives`.
 *
 * Three mutually-exclusive modes (dispatched by
 * {@link runAttachmentDisplayDerivativesRebuild}):
 *
 *   - **generate** (default) — walk every Attachment (optionally narrowed by
 *     `pageId`/`since`/`until`/`onlyMissing`/`onlyStaleRecipe`), skip ones
 *     already on the current recipe (unless `force`), and regenerate the
 *     rest via the SAME write orchestration the upload paths use
 *     (`generateAndPublishDisplayDerivative`, `image-display-derivative.ts`
 *     §7) — this task never re-implements put/publish/compensating-delete.
 *   - **repair-missing** — narrower than `force`: only `mode: 'resized'`
 *     records on the current recipe, existence-probed via a plain `get()`
 *     (no new `StorageDriver` method, spec §やらないこと), regenerating only
 *     the ones whose object is actually gone.
 *   - **gc** — local-driver-only (duck-typed via the driver's opt-in
 *     `listDerivativeObjects()`, `@crowi/plugin-storage-local`): diff the
 *     referenced-key set against what's actually on disk, apply a
 *     grace-period, report (or, with `confirm`, delete) the orphans.
 *
 * Cursor discipline (spec §11): a SINGLE producer loop is the only caller of
 * `cursor.next()` (via {@link forEachBounded}, which drives the iterator
 * protocol manually rather than via `for await...of` — see its own doc
 * comment for why); only the PROCESSING of each pulled item is fanned out to
 * a bounded worker pool (`runner.concurrency`). `MigrationRunnerCore.mapBounded`
 * is NOT used here — it requires an already-`toArray()`'d `items: readonly
 * T[]`, which would break the constant-memory guarantee a Mongo cursor gives
 * us.
 */

import { randomBytes } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { mkdir, rm, statfs } from 'node:fs/promises';
import path from 'node:path';
import type { Readable } from 'node:stream';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { StorageDriver } from '@crowi/plugin-api';
import Debug from 'debug';

import type Crowi from 'src/crowi';
import type { RebuildRunner } from 'src/migration/rebuild-runner';
import type { MigrationContext } from 'src/migration/types';
import type { AttachmentDocument } from 'src/models/attachment';
import FileUploader, { isMissingFileError } from 'src/util/file-uploader';
import { DISPLAY_DERIVATIVE_RECIPE_VERSION, type GenerateAndPublishResult, generateAndPublishDisplayDerivative } from 'src/util/image-display-derivative';

const debug = Debug('crowi:util:rebuild-attachment-display-derivatives');

// ---------------------------------------------------------------------------
// Options / stats
// ---------------------------------------------------------------------------

export interface AttachmentDisplayDerivativesTaskOptions {
  /** generate mode only — re-evaluate attachments already on the current recipe. */
  force?: boolean;
  /** Narrower single-purpose mode — see module doc comment. */
  repairMissing?: boolean;
  /** local-driver-only mode — see module doc comment. */
  gc?: boolean;
  /** Actually perform `gc` deletions (default: report only). */
  confirm?: boolean;
  /** `gc` grace period in hours — objects newer than this are never deleted. Default 24. */
  gcGraceHours?: number;
  /** Only target attachments with no `derivatives.display` recorded at all. */
  onlyMissing?: boolean;
  /** Only target attachments whose recorded `recipeVersion` is not the current one. */
  onlyStaleRecipe?: boolean;
  /** Only target attachments on this page. */
  pageId?: string;
  /** Only target attachments created on/after this instant. */
  since?: Date;
  /** Only target attachments created on/before this instant. */
  until?: Date;
}

/** Injectable seam for tests (mirrors `generateDisplayDerivativeForUpload`'s `admission` override param) — defaults to a real `statfs`-based check on `crowi.tmpDir`. */
export interface AttachmentDisplayDerivativesDeps {
  checkFreeBytes?: (dir: string) => Promise<number>;
  /**
   * Hard per-item cap (bytes) enforced WHILE staging an original into
   * `crowi.tmpDir` (spec §11's "1 アイテムあたりの上限は 100MB" — see
   * {@link PER_ITEM_STAGE_ESTIMATE_BYTES}'s doc comment for why this stays
   * 100MB independent of the current live upload limit). Also the figure
   * the disk-space precheck multiplies by `--concurrency`. Defaults to
   * `PER_ITEM_STAGE_ESTIMATE_BYTES`; overridable for tests so the
   * concurrently-staged-bytes bound can be exercised without multi-hundred-MB
   * fixtures.
   */
  perItemStageLimitBytes?: number;
}

export interface AttachmentDisplayDerivativesFailure {
  attachmentId: string;
  reason: string;
}

export interface GenerateModeStats {
  mode: 'generate';
  scanned: number;
  skippedCurrent: number;
  passthrough: number;
  unsupported: number;
  generated: number;
  failed: number;
  bytesOriginal: number;
  bytesDerived: number;
  bytesSaved: number;
  /** dry-run only — items that WOULD be processed (no decode/write happens). */
  wouldProcess: number;
  interrupted: boolean;
  failures: AttachmentDisplayDerivativesFailure[];
}

export interface RepairMissingModeStats {
  mode: 'repair-missing';
  checked: number;
  stillPresent: number;
  /** Found missing — a regeneration was attempted (or, in dry-run, would be). */
  repaired: number;
  /** Subset of `repaired` whose regeneration actually completed (mode !== 'failed'). Always 0 in dry-run (no regeneration is attempted). */
  missingAndRepaired: number;
  failed: number;
  interrupted: boolean;
  failures: AttachmentDisplayDerivativesFailure[];
}

export interface GcModeStats {
  mode: 'gc';
  /** False when the active driver does not support GC (not local) — spec: report "unsupported" and exit cleanly. */
  supported: boolean;
  candidateCount: number;
  candidateBytes: number;
  reclaimedCount: number;
  reclaimedBytes: number;
  failed: number;
  failures: AttachmentDisplayDerivativesFailure[];
}

export type AttachmentDisplayDerivativesStats = GenerateModeStats | RepairMissingModeStats | GcModeStats;

// ---------------------------------------------------------------------------
// Shared constants / helpers
// ---------------------------------------------------------------------------

/**
 * Per-item disk estimate for staging an original into `crowi.tmpDir` (spec
 * §11). Deliberately NOT tied to the api's current live upload size limit
 * (`hono/handlers/attachment.ts`, hard ceiling 50MB): an already-stored
 * attachment can exceed today's limit (uploaded under a higher one that was
 * since lowered) and still need its derivative rebuilt, so this estimate
 * has to bound the largest attachment that could plausibly exist on disk,
 * not the largest one uploadable right now. Overestimating a disk-space
 * safety margin for an offline batch tool is harmless — underestimating it
 * is not. Exported for test-side boundary assertions on the disk-space
 * precheck AND the staging byte-limit guard (`createByteLimitGuard`) — the
 * same figure bounds both.
 */
export const PER_ITEM_STAGE_ESTIMATE_BYTES = 100 * 1024 * 1024;
export const DEFAULT_GC_GRACE_HOURS = 24;

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Classifies a per-item failure without touching Mongo/storage further than what already happened before the throw. */
class RebuildItemError extends Error {
  constructor(
    public readonly reason: string,
    message: string,
  ) {
    super(message);
  }
}

/** Shared by every per-item catch block below: a `RebuildItemError` carries its own classified reason, anything else is a generic publish-error. */
function classifyRebuildFailure(err: unknown): string {
  return err instanceof RebuildItemError ? err.reason : `publish-error: ${errorMessage(err)}`;
}

async function defaultCheckFreeBytes(dir: string): Promise<number> {
  const s = await statfs(dir);
  return s.bavail * s.bsize;
}

/**
 * A passthrough `Transform` that aborts the pipeline with a classified
 * `RebuildItemError` the instant more than `limitBytes` has flowed through it
 * — spec §11's "同時にステージされるファイルサイズの合計が `--concurrency ×
 * 100MB` で有界" bound is only real if it's ENFORCED while streaming, not
 * merely assumed from the api's current live upload size limit, because a
 * legacy/hand-edited row, or one uploaded under a since-lowered limit,
 * could in principle be larger. Every chunk
 * forwarded downstream keeps the running total at or under `limitBytes`, so
 * the staged file on disk never exceeds it — combined with
 * `forEachBounded`'s `concurrency`-bounded worker pool, the total bytes
 * concurrently staged across all in-flight workers is bounded by
 * `concurrency × limitBytes` by construction, not by convention.
 */
function createByteLimitGuard(limitBytes: number): Transform {
  let seen = 0;
  return new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      seen += chunk.length;
      if (seen > limitBytes) {
        callback(new RebuildItemError('original-exceeds-stage-limit', `staged original exceeded the per-item limit of ${limitBytes} bytes`));
        return;
      }
      callback(null, chunk);
    },
  });
}

function buildCommonFilter(opts: Pick<AttachmentDisplayDerivativesTaskOptions, 'pageId' | 'since' | 'until'>): Record<string, unknown> {
  const filter: Record<string, unknown> = {};
  if (opts.pageId) filter.page = opts.pageId;
  if (opts.since || opts.until) {
    const range: Record<string, Date> = {};
    if (opts.since) range.$gte = opts.since;
    if (opts.until) range.$lte = opts.until;
    filter.createdAt = range;
  }
  return filter;
}

/**
 * Single-producer / bounded-consumer fan-out over an async iterable (spec
 * §11) — the ONLY caller of the underlying Mongo cursor's `next()`; only
 * each pulled item's PROCESSING runs concurrently, bounded to `concurrency`
 * in-flight promises at a time. Stops pulling new items once `aborted()` is
 * true (SIGINT), but always awaits whatever is already in flight before
 * returning.
 *
 * Deliberately does NOT use a `for await...of` loop here: that construct
 * calls the iterator's `next()` to evaluate the loop condition BEFORE the
 * loop body (where an `if (aborted()) break` would run) ever executes, so a
 * SIGINT landing between two iterations would still pull-and-discard one
 * extra item from the cursor before the abort check is ever consulted —
 * harmless for `break`'s discard-the-value semantics, but it defeats the
 * "single producer, stop intake immediately on abort" guarantee this
 * function exists to provide (a cursor `next()` is a real network round trip
 * against Mongo, not a free operation to throw away). Driving the iterator
 * protocol manually lets the abort check gate `next()` itself.
 */
export async function forEachBounded<T>(
  source: AsyncIterable<T>,
  concurrency: number,
  aborted: () => boolean,
  worker: (item: T) => Promise<void>,
): Promise<{ interrupted: boolean }> {
  const limit = Math.max(1, concurrency);
  const inFlight = new Set<Promise<void>>();
  const iterator = source[Symbol.asyncIterator]();

  while (!aborted()) {
    const { value, done } = await iterator.next();
    if (done) break;
    const p = worker(value).finally(() => {
      inFlight.delete(p);
    });
    inFlight.add(p);
    if (inFlight.size >= limit) {
      await Promise.race(inFlight);
    }
  }
  // Mirrors `for await...of`'s implicit `IteratorClose` on early exit (e.g.
  // releases the Mongo cursor's underlying resources) — manual iteration
  // does not get this for free.
  await iterator.return?.();
  await Promise.all(inFlight);
  return { interrupted: aborted() };
}

/** Stage the original bytes for `doc` into a fresh file under `crowi.tmpDir`, checking free space first and enforcing `perItemStageLimitBytes` while streaming (spec §11). Throws a classified `RebuildItemError` on any failure. The staged tmp file is ALWAYS removed on the way out (success, classified failure, or an unexpected throw) — cleanup does not depend on how far staging got, since `createWriteStream` can leave a partial file behind even when `pipeline()` rejects mid-stream. */
async function stageAndGenerate(
  crowi: Crowi,
  doc: Pick<AttachmentDocument, '_id' | 'page' | 'filePath' | 'derivatives'>,
  concurrency: number,
  checkFreeBytes: (dir: string) => Promise<number>,
  perItemStageLimitBytes: number,
): Promise<GenerateAndPublishResult> {
  await mkdir(crowi.tmpDir, { recursive: true });

  const required = Math.max(1, concurrency) * perItemStageLimitBytes;
  let available: number;
  try {
    available = await checkFreeBytes(crowi.tmpDir);
  } catch (err) {
    throw new RebuildItemError('disk-space-check-failed', errorMessage(err));
  }
  if (available < required) {
    throw new RebuildItemError(
      'insufficient-disk-space',
      `only ${available} bytes free under ${crowi.tmpDir}, need ~${required} (concurrency=${concurrency} x ${perItemStageLimitBytes} bytes/item)`,
    );
  }

  const tmpPath = path.join(crowi.tmpDir, `rebuild-display-derivative-${randomBytes(8).toString('hex')}`);
  try {
    let source: Readable;
    try {
      source = await FileUploader(crowi).findDeliveryFile(doc._id, doc.filePath);
    } catch (err) {
      throw new RebuildItemError('original-missing', errorMessage(err));
    }
    try {
      // The byte-limit guard sits BETWEEN the source and the write stream so
      // the file on disk never grows past `perItemStageLimitBytes`, even for
      // a pathological/legacy original larger than the upload-time cap this
      // limit is based on (spec §11).
      await pipeline(source, createByteLimitGuard(perItemStageLimitBytes), createWriteStream(tmpPath));
    } catch (err) {
      if (err instanceof RebuildItemError) throw err;
      throw new RebuildItemError('staging-io-error', errorMessage(err));
    }

    return await generateAndPublishDisplayDerivative({
      crowi,
      attachmentId: doc._id,
      pageId: doc.page,
      sourcePath: tmpPath,
      oldFilePath: doc.derivatives?.display?.filePath,
    });
  } finally {
    // `rm(..., { force: true })` is a no-op when the file was never created
    // (e.g. `findDeliveryFile` failed before staging started) and still
    // removes a PARTIAL file left by a byte-limit/staging-IO failure mid
    // `pipeline()` — cleanup no longer depends on tracking how far staging
    // got.
    await rm(tmpPath, { force: true }).catch((err) => {
      debug('failed to clean up staged tmp file %s: %s', tmpPath, errorMessage(err));
    });
  }
}

// ---------------------------------------------------------------------------
// generate mode
// ---------------------------------------------------------------------------

// `fileFormat` is projected (unused directly by this task's own logic — the
// generator classifies purely by decoding via `sharp`, never by trusting the
// stored MIME string) so the cursor's field selection matches what this
// module's own design doc (the rebuild task's `newFiles` description)
// specifies, rather than silently omitting a field a future reader might
// assume is present on `doc`. `fileSize` is ADDITIONALLY projected (on top
// of that) because `processGenerateItem` needs it for the bytes-original /
// bytes-saved progress counters (spec §11's `bytes-original` /
// `bytes-derived` / `bytes-saved`).
const GENERATE_PROJECTION = { page: 1, filePath: 1, fileFormat: 1, fileSize: 1, 'derivatives.display': 1 } as const;

function buildGenerateFilter(opts: AttachmentDisplayDerivativesTaskOptions): Record<string, unknown> {
  const filter = buildCommonFilter(opts);
  if (opts.onlyMissing) filter['derivatives.display'] = { $exists: false };
  if (opts.onlyStaleRecipe) filter['derivatives.display.recipeVersion'] = { $ne: DISPLAY_DERIVATIVE_RECIPE_VERSION };
  return filter;
}

async function processGenerateItem(
  crowi: Crowi,
  doc: AttachmentDocument,
  concurrency: number,
  dryRun: boolean,
  force: boolean,
  checkFreeBytes: (dir: string) => Promise<number>,
  perItemStageLimitBytes: number,
  stats: GenerateModeStats,
): Promise<void> {
  stats.scanned += 1;

  const display = doc.derivatives?.display;
  const isCurrent = display !== undefined && display.recipeVersion === DISPLAY_DERIVATIVE_RECIPE_VERSION && display.mode !== 'failed';
  if (isCurrent && !force) {
    stats.skippedCurrent += 1;
    return;
  }

  if (dryRun) {
    stats.wouldProcess += 1;
    return;
  }

  try {
    const result = await stageAndGenerate(crowi, doc, concurrency, checkFreeBytes, perItemStageLimitBytes);
    stats.bytesOriginal += doc.fileSize ?? 0;

    if (!result.published) {
      // The Attachment row was deleted concurrently before this item's
      // publish landed (spec §10 case B/C) — `generateAndPublishDisplayDerivative`'s
      // own compensating delete already removed whatever it just `put`, so
      // there is nothing to report as generated/passthrough/unsupported
      // here: the item is simply gone, not a failure needing a retry.
      // `mode: 'failed'` classifications are still recorded below even when
      // unpublished — generation itself did fail, and a retry is moot
      // either way since the row no longer exists.
      if (result.derivative.mode !== 'failed') return;
    }

    switch (result.derivative.mode) {
      case 'resized':
        stats.generated += 1;
        stats.bytesDerived += result.derivative.size ?? 0;
        stats.bytesSaved += Math.max(0, (doc.fileSize ?? 0) - (result.derivative.size ?? 0));
        break;
      case 'passthrough':
        stats.passthrough += 1;
        break;
      case 'unsupported':
        stats.unsupported += 1;
        break;
      case 'failed':
        stats.failed += 1;
        stats.failures.push({ attachmentId: String(doc._id), reason: result.derivative.reason ?? 'unknown-error' });
        break;
    }
  } catch (err) {
    stats.failed += 1;
    stats.failures.push({ attachmentId: String(doc._id), reason: classifyRebuildFailure(err) });
  }
}

/**
 * Shared shell for every mode below: stream an Attachment cursor (constant
 * memory, not loaded into an array — spec §... "at any collection size")
 * through `forEachBounded` at `runner.concurrency`, labeling progress
 * BEFORE each item starts (mirrors `storageCopyRebuild`'s `onProgress`
 * 'start' bridge, `migration/rebuilds/index.ts` — gives the CLI's
 * `liveProgress()`, and any custom test `ProgressReporter`, a per-item
 * heartbeat as each attachment begins processing, not only after the whole
 * run finishes) and incrementing after, regardless of per-item outcome.
 * Only the filter/projection/per-item processor differ between modes.
 */
async function runCursorMode<TStats extends { interrupted: boolean }>(
  crowi: Crowi,
  filter: Record<string, unknown>,
  projection: Record<string, 1>,
  runner: Pick<RebuildRunner, 'concurrency' | 'aborted'>,
  ctx: MigrationContext,
  stats: TStats,
  processItem: (doc: AttachmentDocument) => Promise<void>,
): Promise<TStats> {
  const Attachment = crowi.model('Attachment');
  const cursor = Attachment.find(filter, projection).sort({ _id: 1 }).cursor();

  const { interrupted } = await forEachBounded(
    cursor,
    runner.concurrency,
    () => runner.aborted,
    async (rawDoc) => {
      const doc = rawDoc as AttachmentDocument;
      ctx.progress.setLabel(String(doc._id));
      try {
        await processItem(doc);
      } finally {
        ctx.progress.increment();
      }
    },
  );
  stats.interrupted = interrupted;
  return stats;
}

async function runGenerateMode(
  crowi: Crowi,
  opts: AttachmentDisplayDerivativesTaskOptions,
  ctx: MigrationContext,
  runner: Pick<RebuildRunner, 'concurrency' | 'aborted'>,
  checkFreeBytes: (dir: string) => Promise<number>,
  perItemStageLimitBytes: number,
): Promise<GenerateModeStats> {
  const stats: GenerateModeStats = {
    mode: 'generate',
    scanned: 0,
    skippedCurrent: 0,
    passthrough: 0,
    unsupported: 0,
    generated: 0,
    failed: 0,
    bytesOriginal: 0,
    bytesDerived: 0,
    bytesSaved: 0,
    wouldProcess: 0,
    interrupted: false,
    failures: [],
  };

  return runCursorMode(crowi, buildGenerateFilter(opts), GENERATE_PROJECTION, runner, ctx, stats, (doc) =>
    processGenerateItem(crowi, doc, runner.concurrency, ctx.dryRun, Boolean(opts.force), checkFreeBytes, perItemStageLimitBytes, stats),
  );
}

// ---------------------------------------------------------------------------
// repair-missing mode
// ---------------------------------------------------------------------------

const REPAIR_MISSING_PROJECTION = { page: 1, filePath: 1, 'derivatives.display': 1 } as const;

function buildRepairMissingFilter(opts: AttachmentDisplayDerivativesTaskOptions): Record<string, unknown> {
  return {
    ...buildCommonFilter(opts),
    'derivatives.display.mode': 'resized',
    'derivatives.display.recipeVersion': DISPLAY_DERIVATIVE_RECIPE_VERSION,
  };
}

async function repairOneItem(
  crowi: Crowi,
  doc: AttachmentDocument,
  concurrency: number,
  dryRun: boolean,
  checkFreeBytes: (dir: string) => Promise<number>,
  perItemStageLimitBytes: number,
  stats: RepairMissingModeStats,
): Promise<void> {
  stats.checked += 1;

  const filePath = doc.derivatives?.display?.filePath;
  if (!filePath) {
    // The query filter guarantees `mode: 'resized'`, and the generator
    // always sets `filePath` together with `mode: 'resized'` — this only
    // fires on a corrupt/hand-edited row.
    stats.failed += 1;
    stats.failures.push({ attachmentId: String(doc._id), reason: 'missing-derivative-filepath' });
    return;
  }

  let probeStream: Readable;
  try {
    probeStream = await FileUploader(crowi).findDeliveryFile(doc._id, filePath);
  } catch (err) {
    if (!isMissingFileError(err)) {
      stats.failed += 1;
      stats.failures.push({ attachmentId: String(doc._id), reason: 'existence-check-error' });
      return;
    }

    // "Key not found" — the ONLY case `--repair-missing` regenerates.
    stats.repaired += 1;
    if (dryRun) return;

    try {
      const result = await stageAndGenerate(crowi, doc, concurrency, checkFreeBytes, perItemStageLimitBytes);
      if (result.derivative.mode === 'failed') {
        stats.failed += 1;
        stats.failures.push({ attachmentId: String(doc._id), reason: result.derivative.reason ?? 'unknown-error' });
      } else if (result.published) {
        stats.missingAndRepaired += 1;
      }
      // `!result.published && mode !== 'failed'` — the row was deleted
      // concurrently before the publish landed; the compensating delete
      // already cleaned up, nothing to count here (see `processGenerateItem`'s
      // identical rationale).
    } catch (regenerateErr) {
      stats.failed += 1;
      stats.failures.push({ attachmentId: String(doc._id), reason: classifyRebuildFailure(regenerateErr) });
    }
    return;
  }

  // Exists — discard immediately without reading (spec §11: existence-only probe).
  probeStream.destroy();
  stats.stillPresent += 1;
}

async function runRepairMissingMode(
  crowi: Crowi,
  opts: AttachmentDisplayDerivativesTaskOptions,
  ctx: MigrationContext,
  runner: Pick<RebuildRunner, 'concurrency' | 'aborted'>,
  checkFreeBytes: (dir: string) => Promise<number>,
  perItemStageLimitBytes: number,
): Promise<RepairMissingModeStats> {
  const stats: RepairMissingModeStats = {
    mode: 'repair-missing',
    checked: 0,
    stillPresent: 0,
    repaired: 0,
    missingAndRepaired: 0,
    failed: 0,
    interrupted: false,
    failures: [],
  };

  return runCursorMode(crowi, buildRepairMissingFilter(opts), REPAIR_MISSING_PROJECTION, runner, ctx, stats, (doc) =>
    repairOneItem(crowi, doc, runner.concurrency, ctx.dryRun, checkFreeBytes, perItemStageLimitBytes, stats),
  );
}

// ---------------------------------------------------------------------------
// gc mode (local driver only)
// ---------------------------------------------------------------------------

interface LocalGcCandidate {
  key: string;
  size: number;
  mtimeMs: number;
}

/** Driver-specific, opt-in capability — see `@crowi/plugin-storage-local`'s `LocalStorageDriver.listDerivativeObjects`. Duck-typed (not a `StorageDriver` core method, spec §やらないこと) so `--gc` works against whichever driver instance is active without a hard dependency from `@crowi/api` on `@crowi/plugin-storage-local`. */
interface GcCapableStorageDriver extends StorageDriver {
  listDerivativeObjects(): Promise<LocalGcCandidate[]>;
}

function isGcCapableDriver(driver: StorageDriver): driver is GcCapableStorageDriver {
  return typeof (driver as Partial<GcCapableStorageDriver>).listDerivativeObjects === 'function';
}

async function runGcMode(crowi: Crowi, opts: AttachmentDisplayDerivativesTaskOptions, ctx: MigrationContext): Promise<GcModeStats> {
  const stats: GcModeStats = {
    mode: 'gc',
    supported: true,
    candidateCount: 0,
    candidateBytes: 0,
    reclaimedCount: 0,
    reclaimedBytes: 0,
    failed: 0,
    failures: [],
  };

  const activeDriver = crowi.getPlugins().active.storage;
  if (!activeDriver || !isGcCapableDriver(activeDriver)) {
    stats.supported = false;
    return stats;
  }

  // Referenced-key set: the WHOLE instance, not narrowed by any filter —
  // `--gc` reclaims storage globally, so partial consideration (e.g. via a
  // `pageId` filter) would risk treating a live-but-out-of-scope reference
  // as an orphan.
  const Attachment = crowi.model('Attachment');
  const referenced = new Set<string>();
  const refCursor = Attachment.find({ 'derivatives.display.mode': 'resized' }, { 'derivatives.display.filePath': 1 }).cursor();
  for await (const doc of refCursor) {
    const key = (doc as AttachmentDocument).derivatives?.display?.filePath;
    if (key) referenced.add(key);
  }

  const objects = await activeDriver.listDerivativeObjects();

  const graceMs = Math.max(0, opts.gcGraceHours ?? DEFAULT_GC_GRACE_HOURS) * 60 * 60 * 1000;
  const now = Date.now();
  const candidates = objects.filter((obj) => !referenced.has(obj.key) && now - obj.mtimeMs >= graceMs);

  stats.candidateCount = candidates.length;
  stats.candidateBytes = candidates.reduce((sum, c) => sum + c.size, 0);

  const shouldDelete = Boolean(opts.confirm) && !ctx.dryRun;
  if (!shouldDelete) return stats;

  const fileUploader = FileUploader(crowi);
  for (const candidate of candidates) {
    try {
      await fileUploader.deleteFile(undefined, candidate.key);
      stats.reclaimedCount += 1;
      stats.reclaimedBytes += candidate.size;
    } catch (err) {
      stats.failed += 1;
      stats.failures.push({ attachmentId: candidate.key, reason: `gc-delete-failed: ${errorMessage(err)}` });
    }
  }

  return stats;
}

// ---------------------------------------------------------------------------
// Dispatcher
// ---------------------------------------------------------------------------

export async function runAttachmentDisplayDerivativesRebuild(
  crowi: Crowi,
  opts: AttachmentDisplayDerivativesTaskOptions,
  ctx: MigrationContext,
  runner: Pick<RebuildRunner, 'concurrency' | 'aborted'>,
  deps: AttachmentDisplayDerivativesDeps = {},
): Promise<AttachmentDisplayDerivativesStats> {
  const checkFreeBytes = deps.checkFreeBytes ?? defaultCheckFreeBytes;
  const perItemStageLimitBytes = deps.perItemStageLimitBytes ?? PER_ITEM_STAGE_ESTIMATE_BYTES;

  if (opts.gc) return runGcMode(crowi, opts, ctx);
  if (opts.repairMissing) return runRepairMissingMode(crowi, opts, ctx, runner, checkFreeBytes, perItemStageLimitBytes);
  return runGenerateMode(crowi, opts, ctx, runner, checkFreeBytes, perItemStageLimitBytes);
}
