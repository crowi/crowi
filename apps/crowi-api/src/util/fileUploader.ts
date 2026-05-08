import { createReadStream } from 'node:fs';
import { Readable } from 'node:stream';
import type Crowi from 'src/crowi';
import type { StorageDriver } from '@crowi/plugin-api';

/**
 * Thin facade over the plugin-provided storage driver. The driver is
 * resolved at the moment of each call (not cached at module init)
 * because PluginManager.bootstrap completes after this module is
 * required.
 *
 * Throws a clear error if no storage driver is registered — that
 * means the operator has neither installed `@crowi/storage-local`
 * (default) nor `@crowi/storage-aws-s3`. Until Step 3 wiring lands
 * fully, this can also fire when the new boot order is used without
 * the plugin packages installed in node_modules.
 */
function activeDriver(crowi: Crowi): StorageDriver {
  const driver = crowi.getPlugins().active.storage;
  if (!driver) {
    throw new Error('Storage driver not registered. Install @crowi/storage-local (default) or @crowi/storage-aws-s3.');
  }
  return driver;
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
    // Drivers without signedUrl (e.g. local) fall back to the API
    // streaming endpoint. Caller controllers know the route.
    return `/_api/attachment/${encodeURIComponent(filePath)}`;
  },
});
