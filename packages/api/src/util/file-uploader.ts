import { createReadStream } from 'node:fs';
import { Readable } from 'node:stream';
import type { StorageDriver } from '@crowi/plugin-api';
import Debug from 'debug';
import type Crowi from 'src/crowi';

const debug = Debug('crowi:util:file-uploader');

// Resolved per call (not cached at module init) because the
// PluginManager bootstraps after this module is required.
function activeDriver(crowi: Crowi): StorageDriver {
  const driver = crowi.getPlugins().active.storage;
  if (!driver) {
    throw new Error('Storage driver not registered. Install @crowi/plugin-storage-local (default) or @crowi/plugin-storage-aws-s3.');
  }
  return driver;
}

/**
 * Look up a storage driver by its registered name. Throws with the list
 * of available drivers when no match — used by the `crowi-admin storage
 * copy` CLI which addresses non-active drivers by name.
 */
export function getStorageDriverByName(crowi: Crowi, name: string): StorageDriver {
  const driver = crowi.getPlugins().storage.get(name);
  if (driver) return driver;
  const available = crowi
    .getPlugins()
    .storage.list()
    .map((d) => d.driverName)
    .join(', ');
  throw new Error(`Storage driver '${name}' is not registered. Available drivers: ${available || '(none)'}.`);
}

export interface FileUploader {
  /**
   * Upload a file from a local path or a Readable stream. Used by the
   * attachment / profile-picture controllers.
   *
   * `filePath` is the storage key (forwarded verbatim to the driver).
   * `type` is the MIME content type. `fileStream` may be a Readable or
   * the path of a temp file on disk (legacy callers pass either).
   */
  uploadFile(filePath: string, type: string, fileStream: Readable | string, options?: Record<string, unknown>): Promise<{ key: string }>;

  /** Stream a stored file back to the caller. */
  findDeliveryFile(attachmentId: unknown, filePath: string): Promise<Readable>;

  /** Delete a stored file. Idempotent. */
  deleteFile(attachmentId: unknown, filePath: string): Promise<void>;

  /**
   * Build a URL the browser can fetch. Drivers that support
   * `signedUrl` (e.g. S3) return a time-limited URL; drivers that
   * don't fall back to the API streaming endpoint.
   *
   * NOTE: For values that get *persisted* (e.g. `user.image`) use
   * {@link persistentUrl} instead — a signed URL expires and would
   * 403 once stored.
   */
  generateUrl(filePath: string, expiresInSec?: number): Promise<string>;

  /**
   * Stable, non-expiring URL for a `user/`-prefixed key, suitable for
   * storing in the DB (`user.image`). Always the `by-key` streaming
   * proxy (`/api/attachments/by-key/:key`), never a time-limited
   * signed URL — regardless of the active driver. The proxy streams
   * from whichever driver is active (local or S3) and is reachable from
   * an `<img src>` via the access-token cookie, so avatars survive past
   * any signed-URL TTL.
   */
  persistentUrl(filePath: string): string;
}

export default (crowi: Crowi): FileUploader => ({
  async uploadFile(filePath, type, fileStream, _options) {
    const stream: Readable = typeof fileStream === 'string' ? createReadStream(fileStream) : fileStream;
    // A driver may reject before ever consuming `stream` — e.g.
    // @crowi/plugin-storage-aws-s3's `requireBucket` throws synchronously
    // when the bucket is unconfigured, before `client.send(...)`, and
    // `activeDriver` below throws synchronously if no driver is
    // registered at all. An fs.ReadStream with no `'error'` listener
    // whose own (possibly delayed) internal `open()` later fails — e.g.
    // because the caller's cleanup-on-error path already unlinked the
    // backing tmp file — crashes the entire process: Node treats an
    // unhandled stream `'error'` event as fatal, unlike a rejected
    // promise. Attach a listener as the very first thing, before
    // resolving the driver or handing the stream to it, so this can
    // never happen regardless of which driver is active or how/when it
    // fails. Harmless alongside drivers that do consume the stream (e.g.
    // the local driver's `pipeline`, which attaches its own listener) —
    // multiple `'error'` listeners on the same stream are fine, this one
    // only logs.
    stream.on('error', (err) => debug('upload stream error', err));
    try {
      const driver = activeDriver(crowi);
      return await driver.put(filePath, stream, { contentType: type });
    } catch (err) {
      // Release the fd (or cancel a pending `open()`) when the driver
      // never consumed the stream — otherwise it leaks until GC.
      // Idempotent: a no-op if the driver's own consumption path (e.g.
      // `pipeline`) already destroyed it on failure.
      stream.destroy();
      throw err;
    }
  },

  async findDeliveryFile(_attachmentId, filePath) {
    const driver = activeDriver(crowi);
    return driver.get(filePath);
  },

  async deleteFile(_attachmentId, filePath) {
    const driver = activeDriver(crowi);
    await driver.delete(filePath);
  },

  async generateUrl(filePath, expiresInSec = 60 * 5) {
    const driver = activeDriver(crowi);
    if (driver.signedUrl) {
      return driver.signedUrl(filePath, expiresInSec);
    }
    // Drivers without signedUrl (e.g. local) fall back to the Hono
    // streaming endpoint mounted at `/api/attachments/by-key/:key`.
    // The `by-key` route only accepts keys under the `user/` prefix
    // (profile pictures); attachment-row-backed files use the
    // `/api/attachments/:id` route via `Attachment.fileUrl`.
    return `${BY_KEY_URL_PREFIX}${encodeURIComponent(filePath)}`;
  },

  persistentUrl(filePath) {
    // Always the stable proxy — never a signed URL — because the value
    // is persisted (e.g. user.image). See the interface doc.
    return `${BY_KEY_URL_PREFIX}${encodeURIComponent(filePath)}`;
  },
});

/**
 * Path prefix used by `generateUrl()` when a driver has no `signedUrl`.
 * Hoisted so the storage-copy migration can recognise the same shape
 * when extracting keys from `User.image` URLs without re-encoding the
 * route knowledge in two places.
 */
export const BY_KEY_URL_PREFIX = '/api/attachments/by-key/';

/**
 * Whether a storage-driver `get()`/`delete()` rejection means the object is
 * simply missing (as opposed to a real failure). Local driver throws
 * `code: 'ENOENT'`; the S3 driver surfaces missing as AWS SDK v3
 * `NoSuchKey` (`$metadata.httpStatusCode === 404`, no `code`).
 *
 * feature-image-derivative-optimization — hoisted here (originally
 * module-private in `hono/handlers/attachment-stream.ts`, spec §9's
 * display-priority fallback classifier) so the `--repair-missing` rebuild
 * mode (spec §11, "existing `get()`-only existence probe") can reuse the
 * IDENTICAL classification instead of duplicating the ENOENT/NoSuchKey shape
 * checks — a `util/` module is the right home since both a `hono/handlers/`
 * consumer and a `util/` consumer need it, and `util/` must not depend on
 * `hono/handlers/`.
 */
export const isMissingFileError = (err: unknown): boolean => {
  const e = err as { code?: string; name?: string; $metadata?: { httpStatusCode?: number } };
  return e.code === 'ENOENT' || e.name === 'NoSuchKey' || e.$metadata?.httpStatusCode === 404;
};
