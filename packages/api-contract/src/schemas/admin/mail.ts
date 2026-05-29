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
