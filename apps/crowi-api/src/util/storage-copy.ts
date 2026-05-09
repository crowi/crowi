import { Readable } from 'node:stream';
import type { StorageDriver } from '@crowi/plugin-api';
import type Crowi from 'src/crowi';
import { BY_KEY_URL_PREFIX, getStorageDriverByName } from 'src/util/fileUploader';

/**
 * Per-key event the caller can hook into for live progress display.
 * Emitted both before a key is copied (`stage: 'start'`) and after
 * (`stage: 'ok' | 'failed' | 'skipped'`).
 */
export interface StorageCopyProgress {
  current: number;
  total: number | null;
  key: string;
  stage: 'start' | 'ok' | 'failed' | 'skipped';
  reason?: string;
}

export interface StorageCopyOptions {
  /** Driver name to read from (must be registered by some loaded plugin). */
  from: string;
  /** Driver name to write to (must be registered by some loaded plugin). */
  to: string;
  /**
   * When true, enumerate the candidate keys and report them but never
   * call `to.put`. Useful as a pre-flight check before a maintenance
   * window.
   */
  dryRun: boolean;
  /** Callback invoked once per key. Optional. */
  onProgress?: (event: StorageCopyProgress) => void;
}

export interface StorageCopySummary {
  ok: number;
  failed: number;
  skipped: number;
  total: number;
  /**
   * In dry-run mode, the first batch of candidate keys (capped at
   * `DRY_RUN_SAMPLE_LIMIT`) so the caller can show what would be
   * copied. Empty in non-dry-run mode.
   */
  sampleKeys: string[];
}

/**
 * Maximum number of keys reported back in `summary.sampleKeys` for a
 * dry run. Keeps stdout / API responses bounded on installations with
 * tens of thousands of attachments.
 */
const DRY_RUN_SAMPLE_LIMIT = 20;

/**
 * Copy every stored object from one driver to another. Iterates
 * `Attachment.find({}).cursor()` for page-attached files and
 * `User.find({ image: ... })` for profile pictures (which are not tracked
 * in the Attachment collection — see User.createUserPictureFilePath).
 *
 * Both source and destination drivers must be **loaded by some plugin**;
 * the active driver concept is irrelevant to the copy. This lets an
 * operator stage data on `s3` while `local` is still active, then flip
 * `crowi.config.json:storage.driver` and restart.
 *
 * Failure mode: per-key errors are logged via `onProgress` and counted in
 * `summary.failed`; the iteration never aborts. Re-running is safe — both
 * the local and S3 drivers do overwrite-by-key on `put`, so partial runs
 * are restartable.
 */
export async function runStorageCopy(crowi: Crowi, opts: StorageCopyOptions): Promise<StorageCopySummary> {
  const fromDriver = getStorageDriverByName(crowi, opts.from);
  const toDriver = getStorageDriverByName(crowi, opts.to);

  if (opts.from === opts.to) {
    throw new Error(`Source and destination drivers must differ (both '${opts.from}').`);
  }

  const Attachment = crowi.model('Attachment');
  const User = crowi.model('User');

  const summary: StorageCopySummary = { ok: 0, failed: 0, skipped: 0, total: 0, sampleKeys: [] };

  // Cursor (not toArray) so memory stays constant on installations with
  // millions of attachment rows.
  const attachmentCursor = Attachment.find({}, { filePath: 1, fileFormat: 1 }).cursor();
  for await (const doc of attachmentCursor) {
    if (!doc.filePath) continue;
    summary.total += 1;
    if (opts.dryRun) {
      recordSkipped(doc.filePath, summary, opts);
      continue;
    }
    await copyOne(fromDriver, toDriver, doc.filePath, doc.fileFormat || 'application/octet-stream', summary, opts);
  }

  // Profile pictures live outside the Attachment collection — they're
  // referenced from `User.image`. The regex pre-filters in Mongo so we
  // don't fetch every user just to skip non-storage URLs (Google avatars
  // etc. captured at OAuth login). Both URL shapes that
  // `fileUploader.generateUrl()` can produce — the by-key proxy form
  // (`/api/v2/attachments/by-key/user%2F<id>.<ext>`) and any signed URL
  // containing the raw `user/<id>.<ext>` segment — match this filter.
  const userCursor = User.find({ image: { $regex: 'user(%2F|/)', $options: 'i' } }, { image: 1 }).cursor();
  for await (const user of userCursor) {
    const key = extractUserPictureKey(user.image);
    if (!key) continue;
    summary.total += 1;
    if (opts.dryRun) {
      recordSkipped(key, summary, opts);
      continue;
    }
    // contentType isn't stored alongside `User.image`; derive from the
    // file extension so S3 still records something sensible in object
    // metadata (no-op on local).
    await copyOne(fromDriver, toDriver, key, contentTypeFromKey(key), summary, opts);
  }

  return summary;
}

function recordSkipped(key: string, summary: StorageCopySummary, opts: StorageCopyOptions): void {
  if (summary.sampleKeys.length < DRY_RUN_SAMPLE_LIMIT) summary.sampleKeys.push(key);
  opts.onProgress?.({ current: summary.total, total: null, key, stage: 'skipped' });
  summary.skipped += 1;
}

async function copyOne(
  fromDriver: StorageDriver,
  toDriver: StorageDriver,
  key: string,
  contentType: string,
  summary: StorageCopySummary,
  opts: StorageCopyOptions,
): Promise<void> {
  opts.onProgress?.({ current: summary.total, total: null, key, stage: 'start' });
  let stream: Readable | null = null;
  try {
    stream = (await fromDriver.get(key)) as Readable;
    await toDriver.put(key, stream, { contentType });
    summary.ok += 1;
    opts.onProgress?.({ current: summary.total, total: null, key, stage: 'ok' });
  } catch (err) {
    // Destroy the source on failure — local `get()` returns an open file
    // descriptor and S3 returns an open socket. Without this, a long run
    // with intermittent failures leaks fds / sockets until GC.
    if (stream && typeof stream.destroy === 'function') stream.destroy();
    summary.failed += 1;
    const reason = err instanceof Error ? err.message : String(err);
    opts.onProgress?.({ current: summary.total, total: null, key, stage: 'failed', reason });
  }
}

/**
 * Extract the `user/<id>.<ext>` storage key from a `User.image` URL.
 *
 * Two URL shapes produced by `fileUploader.generateUrl()` are accepted:
 *   1. Local driver: `<BY_KEY_URL_PREFIX>user%2F<id>.<ext>` — URL-encoded
 *      slash in the path segment (the by-key proxy route).
 *   2. S3 signed URL: `https://<bucket>.s3.<region>.amazonaws.com/user/<id>.<ext>?…`
 *      — the raw path includes the storage key directly.
 *
 * Returns null when no recognisable `user/...` key appears in the URL —
 * the caller treats that as "not backed by our storage" and skips
 * (typically external avatars captured during OAuth login).
 *
 * Exported separately so the unit test can exercise it without bringing
 * up the full Crowi container.
 */
export function extractUserPictureKey(image: string | null | undefined): string | null {
  if (!image) return null;

  // by-key proxy form (anchored to the shared route prefix so a route
  // rename in fileUploader.ts forces this matcher to follow):
  if (image.includes(BY_KEY_URL_PREFIX)) {
    const encoded = image.match(/user%2F([\w.-]+)/i);
    if (encoded) return `user/${encoded[1]}`;
  }

  // raw form: anywhere a `user/<id>.<ext>` substring appears (covers
  // signed URLs from S3 and any other driver that exposes the key in
  // the path).
  const raw = image.match(/user\/([\w.-]+)/);
  if (raw) return `user/${raw[1]}`;

  return null;
}

/**
 * Cheap content-type guess from the file extension. Only handles the
 * extensions Crowi's profile-picture upload route allows; anything else
 * falls back to octet-stream. The driver only stores this as metadata
 * (S3 returns it on subsequent GETs); the actual file bytes are
 * untouched.
 */
function contentTypeFromKey(key: string): string {
  const ext = key.toLowerCase().split('.').pop();
  switch (ext) {
    case 'png':
      return 'image/png';
    case 'jpg':
    case 'jpeg':
      return 'image/jpeg';
    case 'gif':
      return 'image/gif';
    case 'webp':
      return 'image/webp';
    default:
      return 'application/octet-stream';
  }
}
