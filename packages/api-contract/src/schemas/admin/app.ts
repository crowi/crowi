import { z } from 'zod';

/**
 * AWS region — matches the legacy express-form regex (e.g. `ap-northeast-1`).
 * Empty string is allowed so the operator can clear the field; if non-empty it
 * must match the AWS region naming convention.
 */
const AwsRegionSchema = z
  .string()
  .trim()
  .refine((v) => v === '' || /^[a-z]+(-[a-z]+)?-[a-z]+-\d+$/.test(v), {
    message: 'Must be a valid AWS region name (e.g. ap-northeast-1)',
  });

/**
 * Access Key ID — alphanumeric only, matches legacy form. Empty allowed.
 * Real AWS keys are 16-128 chars, but legacy did not enforce the length so we
 * keep it loose.
 */
const AwsAccessKeyIdSchema = z
  .string()
  .trim()
  .refine((v) => v === '' || /^[\dA-Za-z]+$/.test(v), {
    message: 'Access Key ID must be alphanumeric',
  });

/**
 * GET response: the current `app:*` and `upload:aws:*` config slice.
 *
 * `secretAccessKey` is masked — the API never returns the plaintext, only
 * whether a value is currently set. The admin UI uses `hasValue` to decide
 * between rendering an empty input ("set a key") vs. a placeholder ("a key is
 * already set, leave blank to keep").
 */
export const GetAppSettingsResponseSchema = z.object({
  app: z.object({
    title: z.string(),
    confidential: z.string(),
    fileUpload: z.boolean(),
    /**
     * Read-only in this endpoint — managed via the Share settings screen.
     * Surfaced here because the App screen displays it, not because it is
     * editable from here.
     */
    externalShare: z.boolean(),
  }),
  upload: z.object({
    aws: z.object({
      region: z.string(),
      bucket: z.string(),
      accessKeyId: z.string(),
      /** Plaintext is never returned. */
      secretAccessKey: z.object({
        hasValue: z.boolean(),
      }),
    }),
  }),
  /**
   * Whether storage credentials are sufficient for uploads to function.
   * Equivalent to `Config.isUploadable(config)` in the legacy controller.
   */
  isUploadable: z.boolean(),
  /**
   * The Open / Restricted / Closed → open / restricted / closed mapping the
   * legacy admin controller exposed. Useful for the UI to render the current
   * registration mode label without knowing the internal capitalisation.
   */
  registrationMode: z.record(z.string()),
});
export type GetAppSettingsResponse = z.infer<typeof GetAppSettingsResponseSchema>;

/**
 * PUT request body. All fields are optional so partial updates are supported,
 * but when present they must satisfy the per-field validation. Sections (`app`
 * / `upload.aws`) are themselves optional.
 *
 * Semantics for `secretAccessKey`:
 * - omitted (undefined) → leave the stored value untouched.
 * - empty string         → explicitly clear the stored value.
 * - non-empty            → save (auto-encrypted via `isSensitiveConfig`).
 */
export const UpdateAppSettingsRequestSchema = z.object({
  app: z
    .object({
      title: z.string().trim().min(1).max(100).optional(),
      confidential: z.string().max(500).optional(),
      fileUpload: z.boolean().optional(),
    })
    .optional(),
  upload: z
    .object({
      aws: z
        .object({
          region: AwsRegionSchema.optional(),
          bucket: z.string().trim().max(63).optional(),
          accessKeyId: AwsAccessKeyIdSchema.optional(),
          secretAccessKey: z.string().optional(),
        })
        .optional(),
    })
    .optional(),
});
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
