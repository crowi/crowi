import { createExpressEndpoints, initServer } from '@ts-rest/express';
import { apiContract } from '@crowi/api-contract';
import { Express, Router } from 'express';
import Crowi from 'src/crowi';
import { UserDocument } from 'src/models/user';
import Debug from 'debug';

const debug = Debug('crowi:routes:ts-rest:admin:mail');

const asString = (value: unknown): string => (typeof value === 'string' ? value : '');

/**
 * Coerce an unknown stored config value to a port number. Legacy installs may
 * persist this as an empty string (the default) or as a numeric string from
 * older form-encoded saves; in both cases we return 0 to mean "not set".
 */
const asPort = (value: unknown): number => {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value !== '') {
    const n = Number(value);
    return Number.isFinite(n) ? n : 0;
  }
  return 0;
};

export default (crowi: Crowi, _app: Express) => {
  const s = initServer();
  const router = Router();

  const router_ = s.router(apiContract.admin.mail, {
    getMailSettings: async () => {
      const config = crowi.getConfig();
      const ns = (config.crowi ?? {}) as Record<string, unknown>;

      const smtpPassword = asString(ns['mail:smtpPassword']);
      const awsSecret = asString(ns['mail:aws:secretAccessKey']);

      return {
        status: 200 as const,
        body: {
          from: asString(ns['mail:from']),
          smtpHost: asString(ns['mail:smtpHost']),
          smtpPort: asPort(ns['mail:smtpPort']),
          smtpUser: asString(ns['mail:smtpUser']),
          smtpPassword: { hasValue: smtpPassword.length > 0 },
          aws: {
            region: asString(ns['mail:aws:region']),
            accessKeyId: asString(ns['mail:aws:accessKeyId']),
            secretAccessKey: { hasValue: awsSecret.length > 0 },
          },
        },
      };
    },

    /**
     * Partial update. `smtpPassword` and `aws.secretAccessKey` follow the same
     * three-state semantics admin/app uses:
     * - omitted   → not added to the payload, value stays untouched.
     * - empty ''  → forwarded as '' to clear the row.
     * - non-empty → forwarded; auto-encryption kicks in via `isSensitiveConfig`.
     *
     * After persisting we re-run `crowi.setupMailer()` so the in-memory mailer
     * reflects the new values without a server restart.
     */
    updateMailSettings: async ({ body }) => {
      const updates: Record<string, unknown> = {};

      if (body.from !== undefined) updates['mail:from'] = body.from;
      if (body.smtpHost !== undefined) updates['mail:smtpHost'] = body.smtpHost;
      if (body.smtpPort !== undefined) updates['mail:smtpPort'] = body.smtpPort;
      if (body.smtpUser !== undefined) updates['mail:smtpUser'] = body.smtpUser;
      if (body.smtpPassword !== undefined) updates['mail:smtpPassword'] = body.smtpPassword;

      if (body.aws) {
        const { region, accessKeyId, secretAccessKey } = body.aws;
        if (region !== undefined) updates['mail:aws:region'] = region;
        if (accessKeyId !== undefined) updates['mail:aws:accessKeyId'] = accessKeyId;
        if (secretAccessKey !== undefined) updates['mail:aws:secretAccessKey'] = secretAccessKey;
      }

      if (Object.keys(updates).length > 0) {
        debug('updateMailSettings keys=%o', Object.keys(updates));
        await crowi.getConfigService().saveConfig('crowi', updates);
        crowi.setupMailer();
      }

      return { status: 200 as const, body: { ok: true as const } };
    },

    /**
     * Send a test mail to the calling admin's email. Mirrors the legacy
     * `validateMailSetting` controller: builds an SMTP transport from the
     * supplied option (or current saved values) and dispatches a fixed-text
     * mail. Network errors surface as 502.
     */
    sendTestMail: async ({ body, req }) => {
      const user = req.user as UserDocument | undefined;
      if (!user || !user.email) {
        return {
          status: 502 as const,
          body: { error: { code: 'MAIL_TEST_FAILED' as const, message: 'No email address on the calling user' } },
        };
      }

      const config = crowi.getConfig();
      const ns = (config.crowi ?? {}) as Record<string, unknown>;

      const host = body?.smtpHost ?? asString(ns['mail:smtpHost']);
      const port = body?.smtpPort ?? asPort(ns['mail:smtpPort']);
      const smtpUser = body?.smtpUser ?? asString(ns['mail:smtpUser']);
      const smtpPassword = body?.smtpPassword ?? asString(ns['mail:smtpPassword']);

      if (!host || !port) {
        return {
          status: 502 as const,
          body: { error: { code: 'MAIL_TEST_FAILED' as const, message: 'SMTP host / port is not configured' } },
        };
      }

      const option: { host: string; port: number; auth?: { user: string; pass: string }; secure?: boolean } = {
        host,
        port,
      };
      if (smtpUser && smtpPassword) {
        option.auth = { user: smtpUser, pass: smtpPassword };
      }
      if (port === 465) {
        option.secure = true;
      }

      const mailer = crowi.mailer;
      if (!mailer || typeof mailer.createSMTPClient !== 'function') {
        return {
          status: 502 as const,
          body: { error: { code: 'MAIL_TEST_FAILED' as const, message: 'Mailer is not initialized' } },
        };
      }

      const smtpClient = mailer.createSMTPClient(option);

      try {
        await new Promise<void>((resolve, reject) => {
          smtpClient.sendMail(
            {
              to: user.email,
              subject: 'Wiki管理設定のアップデートによるメール通知',
              text: 'このメールは、WikiのSMTP設定のアップデートにより送信されています。',
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
        return {
          status: 502 as const,
          body: { error: { code: 'MAIL_TEST_FAILED' as const, message: error.message } },
        };
      }

      return { status: 200 as const, body: { ok: true as const, to: user.email } };
    },
  });

  createExpressEndpoints(apiContract.admin.mail, router_, router);
  return router;
};
