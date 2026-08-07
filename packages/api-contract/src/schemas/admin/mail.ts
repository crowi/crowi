import { z } from '@hono/zod-openapi';

/**
 * GET response: the sender-independent mail settings.
 *
 * Only `from` lives in core config now; each sender's transport
 * credentials (SMTP host/auth, Resend API key, SES via @crowi/plugin-aws)
 * are edited under `/admin/plugins`. `activeDriver` is the registered
 * name of the currently-active mail sender (e.g. `'smtp'`), shown
 * read-only so the operator knows which plugin's settings to edit.
 */
export const GetMailSettingsResponseSchema = z.object({
  from: z.string(),
  activeDriver: z.string(),
  /** npm name of the plugin that registered the active driver, for
   * linking to its config page. Empty when no sender is active. */
  activePlugin: z.string(),
});
export type GetMailSettingsResponse = z.infer<typeof GetMailSettingsResponseSchema>;

/**
 * PUT request body. `from` is the only editable core mail setting; it is
 * optional so an empty PUT is a no-op.
 */
export const UpdateMailSettingsRequestSchema = z.object({
  from: z.string().trim().max(254).optional(),
});
export type UpdateMailSettingsRequest = z.infer<typeof UpdateMailSettingsRequestSchema>;

export const UpdateMailSettingsResponseSchema = z.object({
  ok: z.literal(true),
});
export type UpdateMailSettingsResponse = z.infer<typeof UpdateMailSettingsResponseSchema>;

/**
 * POST /admin/mail/test request body. No fields — the test mail is sent
 * to the calling admin through the currently-active sender, so there is
 * nothing to override. Kept as an (optional, empty) object so the route
 * still declares a JSON body.
 */
export const SendTestMailRequestSchema = z.object({}).optional();
export type SendTestMailRequest = z.infer<typeof SendTestMailRequestSchema>;

export const SendTestMailResponseSchema = z.object({
  ok: z.literal(true),
  /** Address the test mail was dispatched to (= the calling admin's email). */
  to: z.string(),
});
export type SendTestMailResponse = z.infer<typeof SendTestMailResponseSchema>;

/**
 * feature-core-config-readiness-and-mail — `MAIL_FROM_NOT_CONFIGURED`
 * distinguishes an unset sender address (safe, actionable: "go set it")
 * from any other transport/sender failure (`MAIL_TEST_FAILED`). `message`
 * is always one of a fixed, safe, non-localized fallback strings — never
 * the raw transport exception (e.g. `ECONNREFUSED`) or the config key.
 * The schema is a discriminated union on `code` so `message` is pinned to
 * the exact literal(s) the handler actually sends per code, not an
 * unconstrained string that could accidentally admit raw transport/SDK
 * detail.
 */
export const SendTestMailErrorSchema = z.object({
  error: z.discriminatedUnion('code', [
    z.object({
      code: z.literal('MAIL_FROM_NOT_CONFIGURED'),
      message: z.literal('The mail sender address is not configured.'),
    }),
    z.object({
      code: z.literal('MAIL_TEST_FAILED'),
      message: z.enum(['Failed to send the test email. Check the active mail sender configuration.', 'No email address on the calling user']),
    }),
  ]),
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
