import { initContract } from '@ts-rest/core';
import {
  GetMailSettingsResponseSchema,
  MailSettingsValidationErrorSchema,
  SendTestMailErrorSchema,
  SendTestMailRequestSchema,
  SendTestMailResponseSchema,
  UpdateMailSettingsRequestSchema,
  UpdateMailSettingsResponseSchema,
} from '../../schemas/admin/mail';
import { AdminRequiredErrorSchema, AuthenticationRequiredErrorSchema } from '../../schemas/common';

const c = initContract();

/**
 * Admin-only Mail settings contract.
 *
 * Replaces the legacy POST /_api/admin/settings/mail endpoint. Save and
 * test-send are intentionally separated (the legacy form coupled them: a save
 * with `mail:from` always blocked on a successful SMTP test).
 */
export const adminMailContract = c.router({
  getMailSettings: {
    method: 'GET',
    path: '/admin/mail',
    responses: {
      200: GetMailSettingsResponseSchema,
      401: AuthenticationRequiredErrorSchema,
      403: AdminRequiredErrorSchema,
    },
    summary: 'Read the current Mail settings (SMTP + AWS SES, with secret masking)',
  },
  updateMailSettings: {
    method: 'PUT',
    path: '/admin/mail',
    body: UpdateMailSettingsRequestSchema,
    responses: {
      200: UpdateMailSettingsResponseSchema,
      400: MailSettingsValidationErrorSchema,
      401: AuthenticationRequiredErrorSchema,
      403: AdminRequiredErrorSchema,
    },
    summary: 'Update Mail settings — partial updates, secret masking on input',
  },
  sendTestMail: {
    method: 'POST',
    path: '/admin/mail/test',
    body: SendTestMailRequestSchema,
    responses: {
      200: SendTestMailResponseSchema,
      400: MailSettingsValidationErrorSchema,
      401: AuthenticationRequiredErrorSchema,
      403: AdminRequiredErrorSchema,
      502: SendTestMailErrorSchema,
    },
    summary: 'Send a test mail to the calling admin (req.user.email) using SMTP',
  },
});
