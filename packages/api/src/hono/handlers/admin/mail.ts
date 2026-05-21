/**
 * RFC-0006 Phase 4 Batch 9 — `admin.mail` resource Hono port.
 *
 * Replaces `packages/api/src/routes/ts-rest/admin/mail.ts`. Three
 * admin-only endpoints:
 *
 *   GET  /admin/mail        — read SMTP + AWS SES settings (secrets masked)
 *   PUT  /admin/mail        — partial update (three-state secret semantics)
 *   POST /admin/mail/test   — send a test mail to the calling admin
 *
 * Auth:
 *   - Admin-only via broad `createJwtAdminRequired(crowi)` apply on
 *     `/admin/mail/*` + the bare `/admin/mail` path. The wildcard covers
 *     `/admin/mail/test`.
 */
import { adminMailRoutes } from '@crowi/api-contract';
import type { OpenAPIHono } from '@hono/zod-openapi';
import Debug from 'debug';

import type Crowi from 'src/crowi';
import { coerceNumber, coerceString, getCrowiConfigNamespace } from 'src/util/admin-config';

import type { CrowiHonoBindings } from '../../app';
import { createJwtAdminRequired } from '../../middleware/admin';

const debug = Debug('crowi:hono:handlers:admin:mail');

const KEY_FROM = 'mail:from';
const KEY_SMTP_HOST = 'mail:smtpHost';
const KEY_SMTP_PORT = 'mail:smtpPort';
const KEY_SMTP_USER = 'mail:smtpUser';
const KEY_SMTP_PASSWORD = 'mail:smtpPassword';
const KEY_AWS_REGION = 'mail:aws:region';
const KEY_AWS_ACCESS_KEY = 'mail:aws:accessKeyId';
const KEY_AWS_SECRET = 'mail:aws:secretAccessKey';

export const registerAdminMailRoutes = <E extends OpenAPIHono<CrowiHonoBindings>>(app: E, crowi: Crowi) => {
  app.use('/admin/mail/*', createJwtAdminRequired(crowi));
  app.use('/admin/mail', createJwtAdminRequired(crowi));

  return app
    .openapi(adminMailRoutes.getMailSettingsRoute, async (c) => {
      const ns = getCrowiConfigNamespace(crowi);
      const smtpPassword = coerceString(ns[KEY_SMTP_PASSWORD]);
      const awsSecret = coerceString(ns[KEY_AWS_SECRET]);

      return c.json(
        {
          from: coerceString(ns[KEY_FROM]),
          smtpHost: coerceString(ns[KEY_SMTP_HOST]),
          smtpPort: coerceNumber(ns[KEY_SMTP_PORT]),
          smtpUser: coerceString(ns[KEY_SMTP_USER]),
          smtpPassword: { hasValue: smtpPassword.length > 0 },
          aws: {
            region: coerceString(ns[KEY_AWS_REGION]),
            accessKeyId: coerceString(ns[KEY_AWS_ACCESS_KEY]),
            secretAccessKey: { hasValue: awsSecret.length > 0 },
          },
        },
        200,
      );
    })
    .openapi(adminMailRoutes.updateMailSettingsRoute, async (c) => {
      const body = c.req.valid('json');
      const updates: Record<string, unknown> = {};

      if (body.from !== undefined) updates[KEY_FROM] = body.from;
      if (body.smtpHost !== undefined) updates[KEY_SMTP_HOST] = body.smtpHost;
      if (body.smtpPort !== undefined) updates[KEY_SMTP_PORT] = body.smtpPort;
      if (body.smtpUser !== undefined) updates[KEY_SMTP_USER] = body.smtpUser;
      if (body.smtpPassword !== undefined) updates[KEY_SMTP_PASSWORD] = body.smtpPassword;

      if (body.aws) {
        const { region, accessKeyId, secretAccessKey } = body.aws;
        if (region !== undefined) updates[KEY_AWS_REGION] = region;
        if (accessKeyId !== undefined) updates[KEY_AWS_ACCESS_KEY] = accessKeyId;
        if (secretAccessKey !== undefined) updates[KEY_AWS_SECRET] = secretAccessKey;
      }

      if (Object.keys(updates).length > 0) {
        debug('updateMailSettings keys=%o', Object.keys(updates));
        await crowi.getConfigService().saveConfig('crowi', updates);
        crowi.setupMailer();
      }

      return c.json({ ok: true as const }, 200);
    })
    .openapi(adminMailRoutes.sendTestMailRoute, async (c) => {
      // SendTestMailRequestSchema is `.optional()`, so a bare POST without a
      // body parses as `undefined`. c.req.valid('json') returns undefined
      // when the schema declared optional. Fall back to {} to keep the
      // legacy ts-rest semantics (body or saved-config fallback per field).
      const body = (c.req.valid('json') ?? {}) as {
        smtpHost?: string;
        smtpPort?: number;
        smtpUser?: string;
        smtpPassword?: string;
      };
      const user = c.get('user');
      if (!user?.email) {
        return c.json({ error: { code: 'MAIL_TEST_FAILED' as const, message: 'No email address on the calling user' } }, 502);
      }

      const ns = getCrowiConfigNamespace(crowi);
      const host = body.smtpHost ?? coerceString(ns[KEY_SMTP_HOST]);
      const port = body.smtpPort ?? coerceNumber(ns[KEY_SMTP_PORT]);
      const smtpUser = body.smtpUser ?? coerceString(ns[KEY_SMTP_USER]);
      const smtpPassword = body.smtpPassword ?? coerceString(ns[KEY_SMTP_PASSWORD]);

      if (!host || !port) {
        return c.json({ error: { code: 'MAIL_TEST_FAILED' as const, message: 'SMTP host / port is not configured' } }, 502);
      }

      const option: { host: string; port: number; auth?: { user: string; pass: string }; secure?: boolean } = { host, port };
      if (smtpUser && smtpPassword) option.auth = { user: smtpUser, pass: smtpPassword };
      if (port === 465) option.secure = true;

      const mailer = crowi.mailer;
      if (!mailer || typeof mailer.createSMTPClient !== 'function') {
        return c.json({ error: { code: 'MAIL_TEST_FAILED' as const, message: 'Mailer is not initialized' } }, 502);
      }

      const smtpClient = mailer.createSMTPClient(option);

      try {
        await new Promise<void>((resolve, reject) => {
          smtpClient.sendMail(
            {
              to: user.email,
              subject: 'Crowi: SMTP test mail',
              text: 'This is a test message dispatched from the Crowi admin SMTP settings page.',
            },
            (err: Error | null) => {
              if (err) reject(err);
              else resolve();
            },
          );
        });
      } catch (err) {
        const error = err as Error;
        debug('sendTestMail failed: %s', error.message);
        return c.json({ error: { code: 'MAIL_TEST_FAILED' as const, message: error.message } }, 502);
      }

      return c.json({ ok: true as const, to: user.email }, 200);
    });
};
