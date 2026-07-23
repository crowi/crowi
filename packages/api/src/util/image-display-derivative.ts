/**
 * feature-image-derivative-optimization Phase 1 — shared display-derivative
 * generator + storage-lifecycle orchestration.
 *
 * A "display derivative" is a best-effort, disposable thumbnail-ish
 * re-encode of an uploaded JPEG/PNG/WebP: Exif-orientation applied, capped
 * at 1728px wide, metadata stripped, re-encoded in the same format family.
 * It is a cache, not durable data — every failure mode here degrades to
 * "no derivative", which the delivery handler (Phase 2) safely resolves by
 * falling back to the original.
 *
 * This module has two layers:
 *   - `generateDisplayDerivativeBuffer` — pure classification + encode. No
 *     Mongo, no storage I/O. Reads `sourcePath` (a local file), decides
 *     `mode`/`reason`, and for `mode: 'resized'` returns the re-encoded
 *     bytes in memory.
 *   - `generateAndPublishDisplayDerivative` — the write orchestration from
 *     spec §7 (put → conditional `updateOne` publish → compensating delete
 *     on a lost race → best-effort old-key cleanup). No admission control —
 *     this is the function a future `rebuild` command (Phase 3) calls
 *     directly, bounded only by its own worker pool.
 *   - `generateDisplayDerivativeForUpload` — the ONLY entry point the two
 *     upload handlers call. Wraps the above in the upload-path-only
 *     admission semaphore (§8) and guarantees it never rejects — every
 *     failure mode (admission timeout, decode error, storage error, or any
 *     other unexpected exception) is classified, best-effort persisted as
 *     `mode: 'failed'`, and swallowed so the upload response always
 *     succeeds.
 */
import type { FileHandle } from 'node:fs/promises';
import { open, stat } from 'node:fs/promises';
import { Readable } from 'node:stream';

import Debug from 'debug';
import type { Types } from 'mongoose';
import sharp, { type Metadata, type OutputInfo, type Sharp } from 'sharp';

import type Crowi from 'src/crowi';
import FileUploader from 'src/util/file-uploader';
import { Semaphore } from 'src/util/semaphore';

const debug = Debug('crowi:util:image-display-derivative');

// ---------------------------------------------------------------------------
// Types (also the source of truth for `Attachment.derivatives.display` —
// `models/attachment.ts` imports these rather than redeclaring them, so the
// Mongoose schema and the generator can never drift apart).
// ---------------------------------------------------------------------------

/** `recipeVersion` is a literal `1` in v1 — see spec §6 for why no comparison branch exists yet. */
export const DISPLAY_DERIVATIVE_RECIPE_VERSION = 1 as const;

/** Source of truth for BOTH the TS union below AND the Mongoose schema `enum` (`models/attachment.ts`) — kept as one array so the two can never drift apart. */
export const DISPLAY_DERIVATIVE_MODES = ['resized', 'passthrough', 'unsupported', 'failed'] as const;
export type AttachmentDisplayDerivativeMode = (typeof DISPLAY_DERIVATIVE_MODES)[number];

/** Source of truth for BOTH the TS union below AND the Mongoose schema `enum` (`models/attachment.ts`) — kept as one array so the two can never drift apart. */
export const DISPLAY_DERIVATIVE_REASONS = [
  'within-target-width',
  'no-size-benefit',
  'svg',
  'gif',
  'animated',
  'unsupported-format',
  'decode-error',
  'pixel-limit-exceeded',
  'storage-write-failed',
  'admission-timeout',
  'unknown-error',
] as const;
export type AttachmentDisplayDerivativeReason = (typeof DISPLAY_DERIVATIVE_REASONS)[number];

export interface AttachmentDisplayDerivative {
  recipeVersion: typeof DISPLAY_DERIVATIVE_RECIPE_VERSION;
  mode: AttachmentDisplayDerivativeMode;
  reason?: AttachmentDisplayDerivativeReason;
  /** Storage key of the derivative object. Only set when `mode === 'resized'`. */
  filePath?: string;
  /** MIME type string (e.g. `image/jpeg`) — NOT a sharp decoder identifier. Only set when `mode === 'resized'`. */
  format?: string;
  width?: number;
  height?: number;
  size?: number;
  generatedAt: Date;
}

export interface AttachmentDerivatives {
  display?: AttachmentDisplayDerivative;
}

// ---------------------------------------------------------------------------
// Storage key naming (spec §7) — shared by the generator (write) and
// `Attachment.removeAttachment`'s deterministic-key sweep (delete).
// ---------------------------------------------------------------------------

export const DISPLAY_DERIVATIVE_EXTENSIONS = ['jpg', 'png', 'webp'] as const;
export type DisplayDerivativeExt = (typeof DISPLAY_DERIVATIVE_EXTENSIONS)[number];

const SHARP_FORMAT_TO_EXT: Record<SupportedSharpFormat, DisplayDerivativeExt> = {
  jpeg: 'jpg',
  png: 'png',
  webp: 'webp',
};

/** Fixed conversion table (spec §6) — the ONLY place a sharp format identifier becomes a MIME string. */
const SHARP_FORMAT_TO_MIME: Record<SupportedSharpFormat, string> = {
  jpeg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
};

/** The exhaustive set of `derivatives.display.format` values `generateDisplayDerivativeBuffer` can ever produce — also the Mongoose schema `enum` (`models/attachment.ts`), so the storage layer rejects anything that isn't a real MIME string from this table. */
export const DISPLAY_DERIVATIVE_MIME_TYPES: readonly string[] = Object.values(SHARP_FORMAT_TO_MIME);

export function buildDisplayDerivativeKey(pageId: unknown, attachmentId: unknown, ext: DisplayDerivativeExt): string {
  return `attachment/${String(pageId)}/derivatives/${String(attachmentId)}/display-v1.${ext}`;
}

/** All 3 deterministic v1 key candidates for an attachment — used by the delete-time sweep (spec §10). */
export function displayDerivativeKeyCandidates(pageId: unknown, attachmentId: unknown): string[] {
  return DISPLAY_DERIVATIVE_EXTENSIONS.map((ext) => buildDisplayDerivativeKey(pageId, attachmentId, ext));
}

// ---------------------------------------------------------------------------
// Env-configurable knobs (spec §8) — read fresh on every call (no caching)
// so a test can flip `process.env` between calls; boot-time visibility of a
// malformed value lives in `util/env-schema.ts`'s descriptors, which reuse
// the same "invalid → fall back to default" posture as `COLLAB_MAX_EDITORS_PER_PAGE`.
// ---------------------------------------------------------------------------

const DEFAULT_MAX_INPUT_PIXELS = 50_000_000;
const DEFAULT_ADMISSION_CONCURRENCY = 2;
const DEFAULT_ADMISSION_TIMEOUT_MS = 5000;

/** Max physical width (px) of a generated derivative — spec §1/§8. Not env-overridable (a display constant, not a resource-safety knob). */
export const TARGET_MAX_WIDTH = 1728;

function resolvePositiveIntEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  const trimmed = raw.trim();
  if (!/^\d+$/.test(trimmed)) return fallback;
  const parsed = Number.parseInt(trimmed, 10);
  return parsed > 0 ? parsed : fallback;
}

export function resolveMaxInputPixels(): number {
  return resolvePositiveIntEnv('IMAGE_DERIVATIVE_MAX_PIXELS', DEFAULT_MAX_INPUT_PIXELS);
}

export function resolveAdmissionConcurrency(): number {
  return resolvePositiveIntEnv('IMAGE_DERIVATIVE_ADMISSION_CONCURRENCY', DEFAULT_ADMISSION_CONCURRENCY);
}

export function resolveAdmissionTimeoutMs(): number {
  return resolvePositiveIntEnv('IMAGE_DERIVATIVE_ADMISSION_TIMEOUT_MS', DEFAULT_ADMISSION_TIMEOUT_MS);
}

// ---------------------------------------------------------------------------
// Encode options (recipeVersion 1) — benchmarked against synthetic
// photo-like (gradient + noise) and screenshot-like (flat blocks + hard
// edges) fixtures at 1728px width:
//   - JPEG quality: size grows roughly linearly from q70 (~190KB) to q90
//     (~550KB) on the photo-like fixture; q82 sits just past the q80 knee,
//     close to visually-lossless while still meaningfully smaller than q85+.
//   - WebP quality 80 lands in the same relative position on the same
//     sweep and matches sharp's own upstream default.
//   - PNG compressionLevel 9 (max) + effort 8: on the screenshot-like
//     fixture effort 8 already reaches ~99% of effort 10's size reduction
//     for meaningfully less CPU time (a synthetic photo-as-PNG worst case
//     measured ~4s at effort 8 vs ~6s at effort 10 for a 2000x1150 input).
// Fixed for recipeVersion 1 — see spec's open question.
// ---------------------------------------------------------------------------
const JPEG_ENCODE_OPTIONS = { quality: 82, mozjpeg: true } as const;
const PNG_ENCODE_OPTIONS = { compressionLevel: 9, effort: 8 } as const;
const WEBP_ENCODE_OPTIONS = { quality: 80 } as const;

type SupportedSharpFormat = 'jpeg' | 'png' | 'webp';

function isSupportedSharpFormat(format: string): format is SupportedSharpFormat {
  return format === 'jpeg' || format === 'png' || format === 'webp';
}

function applyEncodeOptions(pipeline: Sharp, format: SupportedSharpFormat): Sharp {
  switch (format) {
    case 'jpeg':
      return pipeline.jpeg(JPEG_ENCODE_OPTIONS);
    case 'png':
      return pipeline.png(PNG_ENCODE_OPTIONS);
    case 'webp':
      return pipeline.webp(WEBP_ENCODE_OPTIONS);
  }
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** sharp/libvips throws a plain `Error` with this message when `limitInputPixels` is exceeded — verified against sharp 0.34.5 (see `common.cc`'s `VError`). */
function isPixelLimitError(err: unknown): boolean {
  return err instanceof Error && /exceeds pixel limit/i.test(err.message);
}

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
/** 4-byte big-endian data length + 4-byte ASCII chunk type. */
const PNG_CHUNK_HEADER_LENGTH = 8;
/** Trailing CRC32 every PNG chunk carries after its data. */
const PNG_CHUNK_CRC_LENGTH = 4;
/**
 * Safety bound on the NUMBER of chunk headers walked before giving up (fail
 * open, treat as non-animated) — guards against a pathological/malformed
 * file forcing an unbounded number of small reads (each iteration only ever
 * reads an 8-byte header; the chunk's declared `dataLength` is used to skip
 * to the next header via the `offset` argument to `handle.read`, never read
 * itself, so a single legitimate-but-huge ancillary chunk — e.g. a large
 * embedded `iCCP` colour profile or `eXIf` blob — costs the same one read as
 * a tiny chunk and must NOT count against this bound). Earlier revisions
 * bounded this by cumulative file OFFSET instead (8 MiB), which
 * false-negatived on real-world APNGs whose combined pre-`acTL` ancillary
 * chunk data exceeded that many bytes even though only a handful of chunk
 * headers were actually walked to reach it — see the `> 8 MiB ancillary
 * chunk` regression test. A count of 10,000 headers is far beyond anything a
 * legitimate PNG's pre-`IDAT` ancillary chunks (`gAMA`/`cHRM`/`sRGB`/`pHYs`/
 * `iCCP`/`eXIf`/`tEXt`/…) would ever produce, while still bounding the
 * number of async reads for a malformed file with many small chunks.
 */
const PNG_CHUNK_SCAN_LIMIT = 10_000;

/**
 * Detect an APNG's `acTL` chunk without decoding pixels.
 *
 * The sharp/libvips build this package ships against does NOT expose
 * multi-frame `pages` for PNG the way it does for
 * GIF/WebP/TIFF/HEIF — verified empirically: a hand-built, spec-conformant
 * 2-frame APNG (`acTL` + per-frame `fcTL`/`fdAT`) round-tripped through
 * `sharp(...).metadata()` (with and without `{ pages: -1 }` / `{ animated:
 * true }`) reports `pages: undefined` regardless. A chunk scan is the only
 * reliable signal available.
 *
 * This walks REAL chunk boundaries (4-byte length + 4-byte type + data +
 * 4-byte CRC) rather than scanning a fixed-size window of raw bytes for the
 * literal string `'acTL'` — a raw byte-window scan both (a) false-negatives
 * when a legitimate `acTL` sits past the window (e.g. behind a large
 * `iCCP`/`eXIf` chunk) and (b) false-positives when the bytes `'acTL'` or
 * `'IDAT'` happen to appear inside an unrelated ancillary chunk's payload
 * (e.g. a `tEXt` comment). Walking chunks in declared-length order and
 * stopping at the first `IDAT`/`IEND` avoids both: per the APNG spec,
 * `acTL` — if present — always appears before the first `IDAT`, and this
 * only ever inspects chunk TYPE bytes at their real offsets, never chunk
 * DATA. Still bounded (`PNG_CHUNK_SCAN_LIMIT`, by chunk count — see its own
 * doc comment for why a byte-offset bound is the wrong shape here) and
 * still "metadata reading", not a pixel decode — consistent with the
 * GIF/SVG classification's no-decode posture (spec §8).
 */
async function pngHasAnimationChunk(filePath: string): Promise<boolean> {
  let handle: FileHandle | null = null;
  try {
    handle = await open(filePath, 'r');

    const sigBuf = Buffer.alloc(PNG_SIGNATURE.length);
    const { bytesRead: sigBytesRead } = await handle.read(sigBuf, 0, PNG_SIGNATURE.length, 0);
    if (sigBytesRead !== PNG_SIGNATURE.length || !sigBuf.equals(PNG_SIGNATURE)) {
      // Not a well-formed PNG signature — let the decode step below fail on its own terms.
      return false;
    }

    const headerBuf = Buffer.alloc(PNG_CHUNK_HEADER_LENGTH);
    let offset = PNG_SIGNATURE.length;
    for (let chunkIndex = 0; chunkIndex < PNG_CHUNK_SCAN_LIMIT; chunkIndex += 1) {
      const { bytesRead } = await handle.read(headerBuf, 0, PNG_CHUNK_HEADER_LENGTH, offset);
      if (bytesRead < PNG_CHUNK_HEADER_LENGTH) return false; // truncated/EOF before another chunk header — no acTL seen
      const dataLength = headerBuf.readUInt32BE(0);
      const type = headerBuf.toString('latin1', 4, 8);
      if (type === 'acTL') return true;
      if (type === 'IDAT' || type === 'IEND') return false; // acTL (if any) must precede IDAT — none seen
      // Skip PAST the chunk's data via the next read's `offset` — the data
      // itself is never read, so a huge `dataLength` here is a single cheap
      // seek, not a cost that should count against `PNG_CHUNK_SCAN_LIMIT`.
      offset += PNG_CHUNK_HEADER_LENGTH + dataLength + PNG_CHUNK_CRC_LENGTH;
    }
    return false; // scan limit exceeded without finding acTL/IDAT/IEND — fail open
  } catch (err) {
    // Fail open (treat as non-animated) — an fs error here means the
    // decode step below will fail on its own terms anyway, and a false
    // negative here is strictly less surprising than crashing generation.
    debug('failed to scan PNG chunks for acTL — treating as non-animated: %s', errorMessage(err));
    return false;
  } finally {
    try {
      await handle?.close();
    } catch (err) {
      // Fail open here too — a close() failure must not propagate out of a
      // "pure generator never throws" helper (see the fail-open branch above).
      debug('failed to close PNG file handle after acTL scan: %s', errorMessage(err));
    }
  }
}

// ---------------------------------------------------------------------------
// Pure generation (no I/O beyond reading `sourcePath`)
// ---------------------------------------------------------------------------

export type GeneratedDisplayDerivative =
  | {
      mode: 'resized';
      ext: DisplayDerivativeExt;
      mimeType: string;
      width: number;
      height: number;
      size: number;
      data: Buffer;
    }
  | {
      mode: 'passthrough' | 'unsupported' | 'failed';
      reason: AttachmentDisplayDerivativeReason;
    };

/**
 * Classify + (when applicable) generate a display derivative from a local
 * file. Never throws — every failure mode classifies as `mode: 'failed'`
 * with a `reason` (spec §6/§8's format table).
 */
export async function generateDisplayDerivativeBuffer(sourcePath: string, opts: { maxInputPixels?: number } = {}): Promise<GeneratedDisplayDerivative> {
  const maxInputPixels = opts.maxInputPixels ?? resolveMaxInputPixels();

  let originalSize: number;
  try {
    originalSize = (await stat(sourcePath)).size;
  } catch (err) {
    debug('failed to stat source file for display derivative generation: %s', errorMessage(err));
    return { mode: 'failed', reason: 'unknown-error' };
  }

  let metadata: Metadata;
  try {
    metadata = await sharp(sourcePath, { limitInputPixels: maxInputPixels }).metadata();
  } catch (err) {
    if (isPixelLimitError(err)) {
      debug('pixel limit exceeded while reading source image metadata: %s', errorMessage(err));
      return { mode: 'failed', reason: 'pixel-limit-exceeded' };
    }
    debug('failed to read source image metadata: %s', errorMessage(err));
    return { mode: 'failed', reason: 'decode-error' };
  }

  const format = metadata.format;
  if (format === 'svg') return { mode: 'unsupported', reason: 'svg' };
  if (format === 'gif') return { mode: 'unsupported', reason: 'gif' };
  if (!isSupportedSharpFormat(format)) return { mode: 'unsupported', reason: 'unsupported-format' };
  if (format === 'webp' && (metadata.pages ?? 1) > 1) return { mode: 'unsupported', reason: 'animated' };
  if (format === 'png' && (await pngHasAnimationChunk(sourcePath))) return { mode: 'unsupported', reason: 'animated' };

  const orientedWidth = metadata.autoOrient?.width ?? metadata.width;
  if (orientedWidth <= TARGET_MAX_WIDTH) {
    return { mode: 'passthrough', reason: 'within-target-width' };
  }

  let encoded: { data: Buffer; info: OutputInfo };
  try {
    const pipeline = sharp(sourcePath, { limitInputPixels: maxInputPixels })
      .rotate()
      .resize({ width: TARGET_MAX_WIDTH, withoutEnlargement: true })
      .toColourspace('srgb');
    encoded = await applyEncodeOptions(pipeline, format).toBuffer({ resolveWithObject: true });
  } catch (err) {
    if (isPixelLimitError(err)) {
      debug('pixel limit exceeded while encoding display derivative: %s', errorMessage(err));
      return { mode: 'failed', reason: 'pixel-limit-exceeded' };
    }
    debug('failed to encode display derivative: %s', errorMessage(err));
    return { mode: 'failed', reason: 'decode-error' };
  }

  if (encoded.data.length >= originalSize) {
    return { mode: 'passthrough', reason: 'no-size-benefit' };
  }

  return {
    mode: 'resized',
    ext: SHARP_FORMAT_TO_EXT[format],
    mimeType: SHARP_FORMAT_TO_MIME[format],
    width: encoded.info.width,
    height: encoded.info.height,
    size: encoded.data.length,
    data: encoded.data,
  };
}

// ---------------------------------------------------------------------------
// Write orchestration (spec §7) — reused, unwrapped, by the future rebuild
// command (Phase 3). No admission control in this layer.
// ---------------------------------------------------------------------------

export interface GenerateAndPublishParams {
  crowi: Crowi;
  attachmentId: Types.ObjectId | string;
  pageId: Types.ObjectId | string;
  /** Local absolute path to the already-durable original bytes (e.g. `persisted.tmpPath`, or a rebuild worker's staged copy). */
  sourcePath: string;
  /** `derivatives.display.filePath` as read BEFORE generation started (`undefined` when there was none). */
  oldFilePath: string | undefined;
}

export interface GenerateAndPublishResult {
  derivative: AttachmentDisplayDerivative;
  /** Whether the `updateOne` publish matched a live Attachment row (`false` means the row was deleted mid-flight — spec §10 case B). */
  published: boolean;
}

async function bestEffortDeleteDerivative(crowi: Crowi, attachmentId: unknown, filePath: string): Promise<void> {
  try {
    await FileUploader(crowi).deleteFile(attachmentId, filePath);
  } catch (err) {
    debug('best-effort derivative delete failed for %s: %s', filePath, errorMessage(err));
  }
}

/**
 * Spec §7 steps 4-5: conditional publish + compensating/old-key cleanup.
 * `newFilePath` is the key just `put` (only defined for `mode: 'resized'`).
 */
async function publishDerivative(
  crowi: Crowi,
  attachmentId: Types.ObjectId | string,
  derivative: AttachmentDisplayDerivative,
  newFilePath: string | undefined,
  oldFilePath: string | undefined,
): Promise<boolean> {
  const Attachment = crowi.model('Attachment');
  // `runValidators: true` — Mongoose does NOT validate `$set` payloads
  // against the schema by default on `updateOne`; without it the
  // `attachmentDisplayDerivativeSchema` enums (mode/reason/format/
  // recipeVersion) would be dead code that only `Attachment.create`/`.save()`
  // ever enforce, and this is the ONLY write path that ever sets
  // `derivatives.display` post-creation.
  const result = await Attachment.updateOne({ _id: attachmentId }, { $set: { 'derivatives.display': derivative } }, { upsert: false, runValidators: true });

  if (result.matchedCount === 0) {
    // The row was deleted between our read and this publish (spec §10 case
    // B) — compensate by removing what we just put so it doesn't orphan.
    if (newFilePath) await bestEffortDeleteDerivative(crowi, attachmentId, newFilePath);
    return false;
  }

  // Old-key cleanup does NOT look at the new record's mode — a
  // resized -> passthrough/unsupported/failed transition (e.g. a
  // `--force` re-evaluation that now hits `no-size-benefit`) must still
  // drop the previous derivative object (spec §7 step 5).
  if (oldFilePath !== undefined && oldFilePath !== newFilePath) {
    await bestEffortDeleteDerivative(crowi, attachmentId, oldFilePath);
  }
  return true;
}

async function publishFailureOnly(
  crowi: Crowi,
  attachmentId: Types.ObjectId | string,
  oldFilePath: string | undefined,
  reason: AttachmentDisplayDerivativeReason,
): Promise<GenerateAndPublishResult> {
  const derivative: AttachmentDisplayDerivative = { recipeVersion: DISPLAY_DERIVATIVE_RECIPE_VERSION, mode: 'failed', reason, generatedAt: new Date() };
  try {
    const published = await publishDerivative(crowi, attachmentId, derivative, undefined, oldFilePath);
    return { derivative, published };
  } catch (err) {
    // Best-effort all the way down — even the publish-a-failure attempt
    // must not throw out of this module (spec §8's "呼び出しはベストエフォート").
    debug('failed to publish failure classification for attachment %s: %s', String(attachmentId), errorMessage(err));
    return { derivative, published: false };
  }
}

/**
 * Generate + publish a display derivative for one attachment. No admission
 * control — callers that need to bound process-wide concurrency wrap this
 * (see `generateDisplayDerivativeForUpload` below for the upload paths).
 *
 * Can throw on a genuinely unexpected failure in the publish step (e.g. a
 * Mongo connectivity error) — `generateDisplayDerivativeForUpload` catches
 * that; a future rebuild command decides its own per-item failure handling.
 */
export async function generateAndPublishDisplayDerivative(params: GenerateAndPublishParams): Promise<GenerateAndPublishResult> {
  const { crowi, attachmentId, pageId, sourcePath, oldFilePath } = params;

  const generated = await generateDisplayDerivativeBuffer(sourcePath);

  if (generated.mode !== 'resized') {
    const derivative: AttachmentDisplayDerivative = {
      recipeVersion: DISPLAY_DERIVATIVE_RECIPE_VERSION,
      mode: generated.mode,
      reason: generated.reason,
      generatedAt: new Date(),
    };
    const published = await publishDerivative(crowi, attachmentId, derivative, undefined, oldFilePath);
    return { derivative, published };
  }

  const newFilePath = buildDisplayDerivativeKey(pageId, attachmentId, generated.ext);
  try {
    await FileUploader(crowi).uploadFile(newFilePath, generated.mimeType, Readable.from(generated.data));
  } catch (err) {
    debug('failed to store display derivative for attachment %s: %s', String(attachmentId), errorMessage(err));
    return publishFailureOnly(crowi, attachmentId, oldFilePath, 'storage-write-failed');
  }

  const derivative: AttachmentDisplayDerivative = {
    recipeVersion: DISPLAY_DERIVATIVE_RECIPE_VERSION,
    mode: 'resized',
    filePath: newFilePath,
    format: generated.mimeType,
    width: generated.width,
    height: generated.height,
    size: generated.size,
    generatedAt: new Date(),
  };
  try {
    const published = await publishDerivative(crowi, attachmentId, derivative, newFilePath, oldFilePath);
    return { derivative, published };
  } catch (err) {
    // The `updateOne` call itself threw (e.g. a Mongo connectivity blip) —
    // NOT the `matchedCount === 0` branch inside `publishDerivative`, which
    // already compensates on its own. Unlike that branch, an exception here
    // means `publishDerivative` never got to decide anything: the object we
    // just `put` above is now orphaned unless we clean it up ourselves.
    // Compensate, then propagate — the doc comment on this function already
    // says callers must handle a throw here (the upload wrapper below
    // catches it and republishes `mode: 'failed'`; a future rebuild command
    // decides its own per-item handling).
    debug('publish threw after a successful storage put for attachment %s — compensating: %s', String(attachmentId), errorMessage(err));
    await bestEffortDeleteDerivative(crowi, attachmentId, newFilePath);
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Admission semaphore (spec §8) — upload paths ONLY. The generator itself
// (above) does not rate-limit; rebuild bounds concurrency via its own
// worker pool instead (spec §11) to avoid double-throttling.
//
// Shared with the link-card OGP fetcher's concurrency cap
// (`renderer/core/link-card/fetch-og.ts`) — `Semaphore` (`src/util/
// semaphore.ts`) is the repo's one bounded-concurrency implementation
// (feature-renderer-core-util-dedup consolidated what used to be two
// independently hand-rolled semaphores with different interface shapes,
// only one of which had a queue-length cap). Adopting it here gives the
// upload admission path a queue-length cap it previously lacked — this
// admission had no bound on how many callers could pile up in `waiters`,
// an existing defect now fixed the same way link-card's own DoS fix
// (`FETCH_QUEUE_LIMIT`, commit 2a9c55e5) bounds it: past
// `ADMISSION_QUEUE_LIMIT` queued uploads, a further `acquire()` fails
// immediately instead of piling up an unbounded number of pending
// Promises.
// ---------------------------------------------------------------------------

/**
 * Queue-length cap for the upload admission semaphore — new in
 * feature-renderer-core-util-dedup (this admission had no cap on its wait
 * queue at all before this consolidation). Sized proportionally to
 * `DEFAULT_ADMISSION_CONCURRENCY` (2) at the SAME 10x ratio link-card's
 * `FETCH_QUEUE_LIMIT` (50) uses over its own `FETCH_CONCURRENCY_LIMIT`
 * (5) — deliberately NOT link-card's literal 50, which is sized for a
 * very different workload (one page's `Promise.all` OGP-fetch fan-out
 * across many unique embedded links). This admission instead gates
 * single-attachment upload requests (footer add / editor paste-D&D) from
 * many concurrent editor sessions — a CPU-bound sharp encode with a much
 * smaller concurrency budget to begin with. 20 keeps the same generous
 * 10x headroom over the encode concurrency cap while still bounding the
 * number of outstanding upload requests under a burst.
 */
export const ADMISSION_QUEUE_LIMIT = 20;

let sharedUploadAdmission: Semaphore | null = null;

/** Lazily-initialised process-wide singleton, mirroring `collab-cap.ts`'s `cachedCounter` pattern. */
function getUploadAdmission(): Semaphore {
  if (!sharedUploadAdmission) sharedUploadAdmission = new Semaphore(resolveAdmissionConcurrency(), ADMISSION_QUEUE_LIMIT, resolveAdmissionTimeoutMs());
  return sharedUploadAdmission;
}

/**
 * The ONLY entry point the upload handlers (footer add / editor
 * paste-D&D) call. Guaranteed to never reject: admission timeout, decode
 * failure, storage failure, and any other unexpected exception are all
 * classified, best-effort persisted as `mode: 'failed'`, and swallowed —
 * the upload response must always succeed (spec §8).
 *
 * `admission` is overridable for tests; production call sites omit it and
 * get the shared process-wide semaphore. Typed as `Pick<Semaphore,
 * 'acquire'>` (not the concrete `Semaphore` class) so a test can pass a
 * plain object literal instead of constructing a real one.
 */
export async function generateDisplayDerivativeForUpload(
  params: GenerateAndPublishParams,
  admission: Pick<Semaphore, 'acquire'> = getUploadAdmission(),
): Promise<GenerateAndPublishResult> {
  const acquired = await admission.acquire(resolveAdmissionTimeoutMs());
  if (!acquired.ok) {
    debug('admission semaphore timed out for attachment %s', String(params.attachmentId));
    return publishFailureOnly(params.crowi, params.attachmentId, params.oldFilePath, 'admission-timeout');
  }

  try {
    return await generateAndPublishDisplayDerivative(params);
  } catch (err) {
    debug('unexpected error generating display derivative for attachment %s: %s', String(params.attachmentId), errorMessage(err));
    return publishFailureOnly(params.crowi, params.attachmentId, params.oldFilePath, 'unknown-error');
  } finally {
    acquired.release();
  }
}
