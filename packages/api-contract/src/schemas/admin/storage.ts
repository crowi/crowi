import { z } from '@hono/zod-openapi';

/**
 * One row in the "installed storage drivers" list. A driver is registered
 * by exactly one plugin (`pluginName`) under a stable `driverName`
 * (e.g. `'local'`, `'s3'`). `isActive` is true for the single driver named
 * by `crowi.config.json:storage.driver`.
 */
export const StorageDriverEntrySchema = z.object({
  driverName: z.string(),
  pluginName: z.string(),
  isActive: z.boolean(),
});
export type StorageDriverEntry = z.infer<typeof StorageDriverEntrySchema>;

/**
 * Active driver pointer. Null when `crowi.config.json` names a driver that
 * no loaded plugin registered — the boot sequence logs a warning and falls
 * back to legacy in-core handling, and the admin UI surfaces this as
 * "no active driver".
 */
export const ActiveStorageDriverSchema = z.object({
  driverName: z.string(),
  pluginName: z.string(),
});
export type ActiveStorageDriver = z.infer<typeof ActiveStorageDriverSchema>;

/**
 * Response for GET /admin/storage. Returns the active driver pointer plus
 * every storage driver registered by a loaded plugin so the admin can see
 * what's installed (and link to each plugin's settings page).
 */
export const GetStorageStatusResponseSchema = z.object({
  active: ActiveStorageDriverSchema.nullable(),
  drivers: z.array(StorageDriverEntrySchema),
});
export type GetStorageStatusResponse = z.infer<typeof GetStorageStatusResponseSchema>;
