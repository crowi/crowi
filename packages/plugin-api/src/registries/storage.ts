import type { Readable } from 'node:stream';

/**
 * Metadata accompanying a `put`. The runtime always provides
 * `contentType`; drivers are free to store additional fields under
 * implementation-specific custom metadata.
 */
export interface StoragePutMeta {
  contentType: string;
}

/** Result of a successful `put`. The driver echoes back the stored key. */
export interface StoragePutResult {
  key: string;
}

/**
 * Storage driver — the file-system abstraction every uploader plugin
 * implements. The runtime resolves the active driver at boot from
 * `crowi.config.json:storage.driver`.
 *
 * Object keys are opaque strings owned by the *caller* (core's
 * file-uploader service), e.g. `attachment/<pageId>/<filename>`.
 * Drivers must round-trip them verbatim to preserve compatibility
 * with files uploaded under v1.x.
 */
export interface StorageDriver {
  /** Write a blob and return its (round-tripped) key. */
  put(key: string, body: Buffer | Readable, meta: StoragePutMeta): Promise<StoragePutResult>;

  /**
   * Stream a blob back. Throws if the key does not exist (drivers must
   * use a recognisable error code; e.g. `NoSuchKey` for S3 / `ENOENT`
   * for local).
   */
  get(key: string): Promise<Readable>;

  /** Delete a blob. Idempotent — no-op if the key is already absent. */
  delete(key: string): Promise<void>;

  /**
   * Optional: produce a time-limited signed URL the browser can fetch
   * directly. When the active driver does not implement this, core
   * falls back to streaming via `get()` through the API.
   */
  signedUrl?(key: string, expiresInSec: number): Promise<string>;
}

/**
 * Storage registry passed to `registerStorage`. A plugin contributes
 * one or more drivers under string keys; the active driver is selected
 * by `crowi.config.json:storage.driver`.
 */
export interface StorageRegistry {
  /**
   * Register a driver under a stable name (e.g. `'s3'`, `'local'`).
   * Names must be unique across all plugins; the PluginManager fails
   * boot on collision.
   */
  register(driverName: string, driver: StorageDriver): void;
}
