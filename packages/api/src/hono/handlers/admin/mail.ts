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
import { coerceString, getCrowiConfigNamespace } from 'src/util/admin-config';

import type { CrowiHonoBindings } from '../../app';
import { createJwtAdminRequired } from '../../middleware/admin';

const debug = Debug('crowi:hono:handlers:admin:mail');

const KEY_FROM = 'mail:from';

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
        await crowi.getConfigService().saveConfig('crowi', { [KEY_FROM]: body.from });
      }

      return c.json({ ok: true as const }, 200);
    })
    .openapi(adminMailRoutes.sendTestMailRoute, async (c) => {
      const user = c.get('user');
      if (!user?.email) {
        return c.json({ error: { code: 'MAIL_TEST_FAILED' as const, message: 'No email address on the calling user' } }, 502);
      }

      try {
        await crowi.getMailer().sendTest(user.email);
      } catch (err) {
        const error = err as Error;
        debug('sendTestMail failed: %s', error.message);
        return c.json({ error: { code: 'MAIL_TEST_FAILED' as const, message: error.message } }, 502);
      }

      return c.json({ ok: true as const, to: user.email }, 200);
    });
};
