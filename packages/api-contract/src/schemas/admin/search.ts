import { z } from 'zod';

/**
 * One row in the "installed search drivers" list. A driver is registered
 * by exactly one plugin (`pluginName`) under a stable `driverName`
 * (e.g. `'elasticsearch'`). `isActive` is true for the single driver named
 * by `crowi.config.json:search.driver`.
 *
 * `supportsRebuild` is true when the driver implements the optional
 * `SearchDriver.rebuild?()` method — drivers without a persistent index
 * (e.g. Mongo regex) omit it. The admin UI uses this to decide whether
 * to surface the `crowi-admin search rebuild` hint.
 */
export const SearchDriverEntrySchema = z.object({
  driverName: z.string(),
  pluginName: z.string(),
  isActive: z.boolean(),
  supportsRebuild: z.boolean(),
});
export type SearchDriverEntry = z.infer<typeof SearchDriverEntrySchema>;

/**
 * Active driver pointer. Null when `crowi.config.json` names a driver that
 * no loaded plugin registered, or when no `search.driver` is configured at
 * all (search becomes unavailable and the API returns 503 — see
 * `routes/ts-rest/search.ts`).
 */
export const ActiveSearchDriverSchema = z.object({
  driverName: z.string(),
  pluginName: z.string(),
  supportsRebuild: z.boolean(),
});
export type ActiveSearchDriver = z.infer<typeof ActiveSearchDriverSchema>;

/**
 * Response for GET /admin/search. Returns the active driver pointer plus
 * every search driver registered by a loaded plugin so the admin can see
 * what's installed (and link to each plugin's settings page).
 */
export const GetSearchStatusResponseSchema = z.object({
  active: ActiveSearchDriverSchema.nullable(),
  drivers: z.array(SearchDriverEntrySchema),
});
export type GetSearchStatusResponse = z.infer<typeof GetSearchStatusResponseSchema>;
