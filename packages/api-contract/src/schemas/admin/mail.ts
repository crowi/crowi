import { z } from 'zod';

/**
 * AWS region — same regex as admin/app's AwsRegionSchema, mirrored here so the
 * mail module is independently importable. Empty string is allowed so the
 * operator can clear the field.
 */
const AwsRegionSchema = z
  .string()
  .trim()
  .refine((v) => v === '' || /^[a-z]+(-[a-z]+)?-[a-z]+-\d+$/.test(v), {
    message: 'Must be a valid AWS region name (e.g. ap-northeast-1)',
  });

/**
 * Access Key ID — alphanumeric only, matches the legacy form. Empty allowed.
 */
const AwsAccessKeyIdSchema = z
  .string()
  .trim()
  .refine((v) => v === '' || /^[\dA-Za-z]+$/.test(v), {
    message: 'Access Key ID must be alphanumeric',
  });

/**
 * SMTP port — number 1..65535. Empty/blank from the legacy plaintext config
 * surfaces as 0 here (we coerce missing/non-numeric values to 0 on read).
 */
const SmtpPortSchema = z.number().int().min(1).max(65535);

/**
 * GET response: the current `mail:*` config slice.
 *
 * `smtpPassword` and `aws.secretAccessKey` are masked — the API never returns
 * the plaintext, only whether a value is currently set. `accessKeyId` is
 * returned plain (parity with admin/app).
 */
export const GetMailSettingsResponseSchema = z.object({
  from: z.string(),
  smtpHost: z.string(),
  /** 0 means "not set" — the legacy default was empty string. */
  smtpPort: z.number().int().min(0).max(65535),
  smtpUser: z.string(),
  smtpPassword: z.object({
    hasValue: z.boolean(),
  }),
  aws: z.object({
    region: z.string(),
    accessKeyId: z.string(),
    secretAccessKey: z.object({
      hasValue: z.boolean(),
    }),
  }),
});
export type GetMailSettingsResponse = z.infer<typeof GetMailSettingsResponseSchema>;

/**
 * PUT request body. All fields are optional so partial updates are supported.
 *
 * Semantics for `smtpPassword` and `aws.secretAccessKey`:
 * - omitted (undefined) → leave the stored value untouched.
 * - empty string         → explicitly clear the stored value.
 * - non-empty            → save (auto-encrypted via `isSensitiveConfig`).
 */
export const UpdateMailSettingsRequestSchema = z.object({
  from: z.string().trim().max(254).optional(),
  smtpHost: z.string().trim().max(255).optional(),
  smtpPort: SmtpPortSchema.optional(),
  smtpUser: z.string().trim().max(255).optional(),
  smtpPassword: z.string().optional(),
  aws: z
    .object({
      region: AwsRegionSchema.optional(),
      accessKeyId: AwsAccessKeyIdSchema.optional(),
      secretAccessKey: z.string().optional(),
    })
    .optional(),
});
export type UpdateMailSettingsRequest = z.infer<typeof UpdateMailSettingsRequestSchema>;

export const UpdateMailSettingsResponseSchema = z.object({
  ok: z.literal(true),
});
export type UpdateMailSettingsResponse = z.infer<typeof UpdateMailSettingsResponseSchema>;

/**
 * POST /admin/mail/test request body. All fields are optional — when omitted
 * the server uses the currently-saved values. Sending a body lets the operator
 * dry-run a configuration before persisting it.
 */
export const SendTestMailRequestSchema = z
  .object({
    smtpHost: z.string().trim().max(255).optional(),
    smtpPort: SmtpPortSchema.optional(),
    smtpUser: z.string().trim().max(255).optional(),
    smtpPassword: z.string().optional(),
  })
  .optional();
export type SendTestMailRequest = z.infer<typeof SendTestMailRequestSchema>;

export const SendTestMailResponseSchema = z.object({
  ok: z.literal(true),
  /** Address the test mail was dispatched to (= the calling admin's email). */
  to: z.string(),
});
export type SendTestMailResponse = z.infer<typeof SendTestMailResponseSchema>;

export const SendTestMailErrorSchema = z.object({
  error: z.object({
    code: z.literal('MAIL_TEST_FAILED'),
    message: z.string(),
  }),
});
export type SendTestMailError = z.infer<typeof SendTestMailErrorSchema>;

/**
 * Surfaced when the body fails Zod validation.
 */
export const MailSettingsValidationErrorSchema = z.object({
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
export type MailSettingsValidationError = z.infer<typeof MailSettingsValidationErrorSchema>;
