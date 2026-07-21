import { Readable } from 'node:stream';
import type { StorageDriver } from '@crowi/plugin-api';
import type Crowi from 'src/crowi';
import { BY_KEY_URL_PREFIX, getStorageDriverByName } from 'src/util/file-uploader';

export interface StorageCopyProgress {
  current: number;
  total: number | null;
  key: string;
  stage: 'start' | 'ok' | 'failed' | 'skipped';
  reason?: string;
}

export interface StorageCopyOptions {
  from: string;
  to: string;
  /** When true, enumerate candidate keys but never call `to.put`. */
  dryRun: boolean;
  onProgress?: (event: StorageCopyProgress) => void;
}

export interface StorageCopySummary {
  ok: number;
  failed: number;
  skipped: number;
  total: number;
  /** Up to DRY_RUN_SAMPLE_LIMIT keys, populated only on dry-run. */
  sampleKeys: string[];
}

const DRY_RUN_SAMPLE_LIMIT = 20;

/**
 * Copy every stored object from `opts.from` to `opts.to`. Both drivers
 * must be loaded by some plugin; the active-driver concept is irrelevant
 * (an operator can stage data on the new driver while the old one is
 * still active, then flip `crowi.config.json` and restart).
 *
 * Re-running is safe: per-key errors increment `summary.failed` without
 * aborting the iteration, and the local + S3 drivers overwrite by key.
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
 * Two URL shapes produced by `fileUploader.generateUrl()`:
 *   1. Local driver: `<BY_KEY_URL_PREFIX>user%2F<id>.<ext>`
 *   2. S3 signed URL with the raw `user/<id>.<ext>` segment in the path.
 * Returns null for external URLs (e.g. OAuth-captured Google avatars).
 */
export function extractUserPictureKey(image: string | null | undefined): string | null {
  if (!image) return null;

  if (image.includes(BY_KEY_URL_PREFIX)) {
    const encoded = image.match(/user%2F([\w.-]+)/i);
    if (encoded) return `user/${encoded[1]}`;
  }

  const raw = image.match(/user\/([\w.-]+)/);
  if (raw) return `user/${raw[1]}`;

  return null;
}

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
