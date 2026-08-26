/**
 * `admin.mail` resource — sender-independent mail settings.
 *
 * Email transport is plugin-based: each sender (`@crowi/plugin-mail-smtp`,
 * `-resend`, `-aws-ses`) registers a driver and is selected by
 * `crowi.config.json:mail.driver`. Per-sender credentials are edited
 * under `/admin/plugins`. This resource only owns the sender-independent
 * `from` address plus a read-only view of which sender is active.
 *
 *   GET  /admin/mail        — read `from` + active sender driver name
 *   PUT  /admin/mail        — update `from`
 *   POST /admin/mail/test   — send a test mail to the calling admin via
 *                             the active sender
 *
 * Auth:
 *   - Admin-only via `createJwtAdminRequired(crowi)` on `/admin/mail/*`
 *     plus the bare `/admin/mail` path.
 */
import { adminMailRoutes } from '@crowi/api-contract';
import type { OpenAPIHono } from '@hono/zod-openapi';
import Debug from 'debug';

import type Crowi from 'src/crowi';
import { MailFromNotConfiguredError } from 'src/service/mail';
import { coerceString, getCrowiConfigNamespace } from 'src/util/admin-config';

import type { CrowiHonoBindings } from '../../app';
import { createJwtAdminRequired } from '../../middleware/admin';
import { INTERNAL_ERROR_BODY } from '../_helpers/errors';

const debug = Debug('crowi:hono:handlers:admin:mail');

const KEY_FROM = 'mail:from';

// Safe, fixed, non-localized fallback strings — never the raw transport
// exception (e.g. `ECONNREFUSED`, SDK credential errors) or the
// `mail:from` config key. The web client localizes by `error.code`, not
// by this `message`, but it is still never rendered as-is
// (feature-core-config-readiness-and-mail AC-6). `as const` keeps these as
// the exact literal types `SendTestMailErrorSchema` pins per `code`,
// rather than widening to `string`.
const MAIL_FROM_NOT_CONFIGURED_MESSAGE = 'The mail sender address is not configured.' as const;
const MAIL_TEST_FAILED_MESSAGE = 'Failed to send the test email. Check the active mail sender configuration.' as const;

/** Resolve the registered driver + plugin name of the active mail sender. */
const resolveActiveSender = (crowi: Crowi): { driver: string; plugin: string } => {
  const plugins = crowi.getPlugins();
  const active = plugins.active.mail;
  const entry = active ? plugins.mail.entryOf(active) : undefined;
  return { driver: entry?.driverName ?? '', plugin: entry?.plugin ?? '' };
};

export const registerAdminMailRoutes = <E extends OpenAPIHono<CrowiHonoBindings>>(app: E, crowi: Crowi) => {
  app.use('/admin/mail/*', createJwtAdminRequired(crowi));
  app.use('/admin/mail', createJwtAdminRequired(crowi));

  return app
    .openapi(adminMailRoutes.getMailSettingsRoute, async (c) => {
      const ns = getCrowiConfigNamespace(crowi);
      const active = resolveActiveSender(crowi);
      return c.json(
        {
          from: coerceString(ns[KEY_FROM]),
          activeDriver: active.driver,
          activePlugin: active.plugin,
        },
        200,
      );
    })
    .openapi(adminMailRoutes.updateMailSettingsRoute, async (c) => {
      const body = c.req.valid('json');

      if (body.from !== undefined) {
        debug('updateMailSettings from=%s', body.from);
        try {
          await crowi.getConfigService().saveConfig('crowi', { [KEY_FROM]: body.from });
        } catch (err) {
          debug('Error saving mail settings:', (err as Error).message);
          return c.json(INTERNAL_ERROR_BODY, 500);
        }
      }

      return c.json({ ok: true as const }, 200);
    })
    .openapi(adminMailRoutes.sendTestMailRoute, async (c) => {
      const user = c.get('user');
      if (!user?.email) {
        return c.json({ error: { code: 'MAIL_TEST_FAILED' as const, message: 'No email address on the calling user' as const } }, 502);
      }

      try {
        await crowi.getMailer().sendTest(user.email, user.lang);
      } catch (err) {
        if (err instanceof MailFromNotConfiguredError) {
          debug('sendTestMail failed: mail:from not configured');
          return c.json({ error: { code: 'MAIL_FROM_NOT_CONFIGURED' as const, message: MAIL_FROM_NOT_CONFIGURED_MESSAGE } }, 502);
        }
        // The full exception (stack trace plus any transport/SDK-specific
        // properties — e.g. nodemailer's `.code` / `.command` /
        // `.responseCode` / `.response`, or a `.cause`) is logged here
        // only, never returned on the wire (AC-6). `%O` pretty-prints the
        // whole object rather than just `error.message`, which alone can
        // be a generic one-liner while the diagnostic detail lives in the
        // other properties.
        debug('sendTestMail failed: %O', err);
        return c.json({ error: { code: 'MAIL_TEST_FAILED' as const, message: MAIL_TEST_FAILED_MESSAGE } }, 502);
      }

      return c.json({ ok: true as const, to: user.email }, 200);
    });
};
