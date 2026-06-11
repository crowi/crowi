import { z } from '@hono/zod-openapi';

/**
 * GET response: the current `app:*` config slice (plus a few read-only
 * derived values used by the admin App page header).
 *
 * AWS S3 credentials used to live here under an `upload.aws` block.
 * Storage credentials are now managed exclusively through the per-plugin
 * settings page (`/admin/plugins?name=@crowi/plugin-aws`); the App
 * settings endpoint no longer surfaces them. Boot-time migration copies
 * the legacy `upload:aws:*` keys into the new `plugin:@crowi/plugin-aws:*`
 * namespace — see `packages/api/src/util/aws-config-migration.ts`.
 */
export const GetAppSettingsResponseSchema = z.object({
  app: z.object({
    title: z.string(),
    confidential: z.string(),
  }),
  /**
   * Whether a storage driver is registered (i.e. uploads are wired up).
   * Sourced from `Config.isUploadable()` which now consults PluginManager.
   */
  isUploadable: z.boolean(),
  /**
   * The Open / Restricted / Closed → open / restricted / closed mapping the
   * legacy admin controller exposed. Useful for the UI to render the current
   * registration mode label without knowing the internal capitalisation.
   */
  registrationMode: z.record(z.string(), z.string()),
  /**
   * Whether the admin has dismissed the initial-setup checklist on the
   * dashboard. Persisted server-side (`app:setupChecklistDismissed`) so the
   * dismissal holds across browsers and devices, not just one localStorage.
   */
  setupChecklistDismissed: z.boolean(),
});
export type GetAppSettingsResponse = z.infer<typeof GetAppSettingsResponseSchema>;

/**
 * PUT request body. All fields are optional so partial updates are supported,
 * but when present they must satisfy the per-field validation. The `app`
 * section itself is also optional.
 *
 * Strict on the top-level so unknown keys (e.g. a stray `upload` from a
 * stale client) are rejected with a per-field 400 — this is the contract's
 * way of advertising that storage credentials moved to the plugin settings
 * page.
 */
export const UpdateAppSettingsRequestSchema = z
  .object({
    app: z
      .object({
        title: z.string().trim().min(1).max(100).optional(),
        confidential: z.string().max(500).optional(),
      })
      .optional(),
    /**
     * Toggle the dashboard initial-setup checklist's dismissed state. Sent on
     * its own (without the `app` block) when the admin clicks "mark as done".
     */
    setupChecklistDismissed: z.boolean().optional(),
  })
  .strict();
export type UpdateAppSettingsRequest = z.infer<typeof UpdateAppSettingsRequestSchema>;

export const UpdateAppSettingsResponseSchema = z.object({
  ok: z.literal(true),
});
export type UpdateAppSettingsResponse = z.infer<typeof UpdateAppSettingsResponseSchema>;

/**
 * Surfaced when the body fails Zod validation. ts-rest emits this shape on
 * `body` parse failure with a 400 status; the UI uses it to map per-field
 * messages back onto the form.
 */
export const AppSettingsValidationErrorSchema = z.object({
  bodyResult: z.object({
    issues: z.array(
      z.object({
        path: z.array(z.union([z.string(), z.number()])),
        message: z.string(),
      }),
    ),
    name: z.string().optional(),
  }),
});
export type AppSettingsValidationError = z.infer<typeof AppSettingsValidationErrorSchema>;
