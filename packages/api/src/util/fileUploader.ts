import { createReadStream } from 'node:fs';
import { Readable } from 'node:stream';
import type Crowi from 'src/crowi';
import type { StorageDriver } from '@crowi/plugin-api';

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
   */
  generateUrl(filePath: string, expiresInSec?: number): Promise<string>;
}

export default (crowi: Crowi): FileUploader => ({
  async uploadFile(filePath, type, fileStream, _options) {
    const driver = activeDriver(crowi);
    const stream: Readable = typeof fileStream === 'string' ? createReadStream(fileStream) : fileStream;
    return driver.put(filePath, stream, { contentType: type });
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
    // Drivers without signedUrl (e.g. local) fall back to the ts-rest
    // streaming endpoint mounted at `/api/v2/attachments/by-key/:key`.
    // The `by-key` route only accepts keys under the `user/` prefix
    // (profile pictures); attachment-row-backed files use the
    // `/api/v2/attachments/:id` route via `Attachment.fileUrl`.
    return `${BY_KEY_URL_PREFIX}${encodeURIComponent(filePath)}`;
  },
});

/**
 * Path prefix used by `generateUrl()` when a driver has no `signedUrl`.
 * Hoisted so the storage-copy migration can recognise the same shape
 * when extracting keys from `User.image` URLs without re-encoding the
 * route knowledge in two places.
 */
export const BY_KEY_URL_PREFIX = '/api/v2/attachments/by-key/';
