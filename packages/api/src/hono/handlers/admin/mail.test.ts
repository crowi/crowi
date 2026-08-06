import request from 'supertest';
import type { MailSender } from '@crowi/plugin-api';
import Debug from 'debug';
import { app, crowi, Fixture } from 'src/test/setup';
import { authHeaders } from 'src/test/test-helpers';
import { createJwtUtil } from 'src/util/jwt';

const createUser = async (info: { name: string; username: string; email: string }, admin = false) => {
  const User = crowi.model('User');
  const [user] = await Fixture.generate('User', [info]);
  user.status = User.STATUS_ACTIVE;
  user.admin = admin;
  await user.save();
  const accessToken = createJwtUtil(crowi).generateTokens(user).accessToken;
  return { user, accessToken };
};

const reloadConfigCache = async () => {
  await crowi.getConfigService().load();
};

describe('Routes /api/admin/mail (Hono)', () => {
  let Config;
  let adminToken: string;
  let adminEmail: string;
  let memberToken: string;

  beforeAll(async () => {
    Config = crowi.model('Config');
    const admin = await createUser({ name: 'Mail Admin', username: 'mailAdmin', email: 'mail-admin@example.com' }, true);
    adminToken = admin.accessToken;
    adminEmail = admin.user.email;
    const member = await createUser({ name: 'Mail Member', username: 'mailMember', email: 'mail-member@example.com' }, false);
    memberToken = member.accessToken;
  });

  afterEach(async () => {
    await Config.deleteMany({ ns: 'crowi', key: 'mail:from' });
    await reloadConfigCache();
  });

  describe('GET /api/admin/mail', () => {
    it('returns 401 without auth', async () => {
      const res = await request(app).get('/api/admin/mail');
      expect(res.status).toBe(401);
      expect(res.body.error.code).toBe('AUTHENTICATION_REQUIRED');
    });

    it('returns 403 for a non-admin user', async () => {
      const res = await request(app).get('/api/admin/mail').set(authHeaders(memberToken));
      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe('ADMIN_REQUIRED');
    });

    it('returns the from address and the active sender driver', async () => {
      await Config.updateConfig('crowi', 'mail:from', 'noreply@example.com');
      await reloadConfigCache();

      const res = await request(app).get('/api/admin/mail').set(authHeaders(adminToken));
      expect(res.status).toBe(200);
      // The default-on @crowi/plugin-mail-smtp registers the 'smtp' driver,
      // selected by the default mail.driver. No crowi.config.json in tests.
      expect(res.body).toEqual({ from: 'noreply@example.com', activeDriver: 'smtp', activePlugin: '@crowi/plugin-mail-smtp' });
    });

    it('returns an empty from when unset', async () => {
      const res = await request(app).get('/api/admin/mail').set(authHeaders(adminToken));
      expect(res.status).toBe(200);
      expect(res.body.from).toBe('');
    });
  });

  describe('PUT /api/admin/mail', () => {
    it('returns 401 without auth', async () => {
      const res = await request(app).put('/api/admin/mail').send({ from: 'a@example.com' });
      expect(res.status).toBe(401);
    });

    it('returns 403 for a non-admin user', async () => {
      const res = await request(app).put('/api/admin/mail').set(authHeaders(memberToken)).send({ from: 'a@example.com' });
      expect(res.status).toBe(403);
    });

    it('persists the from address and round-trips via GET', async () => {
      const res = await request(app).put('/api/admin/mail').set(authHeaders(adminToken)).send({ from: 'noreply@example.com' });
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ ok: true });

      const get = await request(app).get('/api/admin/mail').set(authHeaders(adminToken));
      expect(get.status).toBe(200);
      expect(get.body.from).toBe('noreply@example.com');
    });

    it('accepts an empty body and is a no-op', async () => {
      const before = await Config.countDocuments({ ns: 'crowi' }).exec();
      const res = await request(app).put('/api/admin/mail').set(authHeaders(adminToken)).send({});
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ ok: true });
      const after = await Config.countDocuments({ ns: 'crowi' }).exec();
      expect(after).toBe(before);
    });
  });

  describe('POST /api/admin/mail/test', () => {
    let originalMail: MailSender | null;

    beforeEach(() => {
      originalMail = crowi.getPlugins().active.mail;
    });

    afterEach(() => {
      crowi.getPlugins().active.mail = originalMail;
    });

    it('returns 401 without auth', async () => {
      const res = await request(app).post('/api/admin/mail/test').send({});
      expect(res.status).toBe(401);
    });

    it('returns 403 for a non-admin user', async () => {
      const res = await request(app).post('/api/admin/mail/test').set(authHeaders(memberToken)).send({});
      expect(res.status).toBe(403);
    });

    it('sends a test mail to the calling admin via the active sender', async () => {
      await Config.updateConfig('crowi', 'mail:from', 'noreply@example.com');
      await reloadConfigCache();
      const sendSpy = jest.fn(async () => undefined);
      crowi.getPlugins().active.mail = { send: sendSpy };

      const res = await request(app).post('/api/admin/mail/test').set(authHeaders(adminToken)).send({});

      expect(res.status).toBe(200);
      expect(res.body).toEqual({ ok: true, to: adminEmail });
      expect(sendSpy).toHaveBeenCalledTimes(1);
      expect(sendSpy.mock.calls[0][0]).toEqual(
        expect.objectContaining({ to: [adminEmail], from: 'noreply@example.com', text: expect.stringContaining('test message') }),
      );
    });

    it('returns 502 with MAIL_FROM_NOT_CONFIGURED and a safe message when from is not configured (feature-core-config-readiness-and-mail AC-5)', async () => {
      const sendSpy = jest.fn(async () => undefined);
      crowi.getPlugins().active.mail = { send: sendSpy };

      const res = await request(app).post('/api/admin/mail/test').set(authHeaders(adminToken)).send({});

      expect(res.status).toBe(502);
      expect(res.body.error.code).toBe('MAIL_FROM_NOT_CONFIGURED');
      expect(res.body.error.message).not.toMatch(/mail:from/);
      expect(sendSpy).not.toHaveBeenCalled();
    });

    it('returns 502 with MAIL_TEST_FAILED and a safe fixed message — never the underlying transport error — when the sender throws, but logs the original detail server-side (AC-6)', async () => {
      await Config.updateConfig('crowi', 'mail:from', 'noreply@example.com');
      await reloadConfigCache();
      // Mirrors a real nodemailer SMTP transport error: `.message` alone is
      // often a generic one-liner, while the actionable diagnostic detail
      // (`.code`, `.command`) sits in extra properties of the Error object.
      // A log that only captures `error.message` would miss `.code` here.
      const transportError = new Error('connect ECONNREFUSED 127.0.0.1:25');
      Object.assign(transportError, { code: 'ECONNREFUSED', command: 'CONN' });
      crowi.getPlugins().active.mail = {
        send: jest.fn(async () => {
          throw transportError;
        }),
      };

      // Capture the handler's `debug('crowi:hono:handlers:admin:mail')`
      // output directly (rather than asserting on stderr text), by
      // overriding the shared `debug` module's log sink and enabling this
      // namespace — `debug`'s `enabled` getter re-checks `Debug.namespaces`
      // on every call, so this takes effect for the already-constructed
      // handler-module instance without any module reset.
      const previousNamespaces = Debug.disable();
      const originalLog = Debug.log;
      const logSpy = jest.fn();
      Debug.log = logSpy;
      Debug.enable('crowi:hono:handlers:admin:mail');

      let res;
      try {
        res = await request(app).post('/api/admin/mail/test').set(authHeaders(adminToken)).send({});
      } finally {
        Debug.log = originalLog;
        Debug.enable(previousNamespaces);
      }

      expect(res.status).toBe(502);
      expect(res.body.error.code).toBe('MAIL_TEST_FAILED');
      expect(res.body.error.message).not.toMatch(/ECONNREFUSED/);
      expect(JSON.stringify(res.body)).not.toMatch(/ECONNREFUSED/);

      // The raw transport detail never reaches the wire above, but it must
      // still reach the server-side debug log (spec contract: "その他の
      // mail test exception は ... ログに原文を残し"). Assert more than the
      // one-line message: the stack trace and the extra `.code` property
      // (which would NOT appear if only `error.message` were logged) must
      // both be present, so this regression-proofs against logging just
      // `.message` (AC-6).
      expect(logSpy).toHaveBeenCalled();
      const logged = logSpy.mock.calls.map((callArgs) => callArgs.join(' ')).join('\n');
      expect(logged).toMatch(/ECONNREFUSED/);
      expect(logged).toMatch(/at /); // stack trace frame
      expect(logged).toMatch(/code: 'ECONNREFUSED'/); // extra property beyond `.message`
    });
  });
});
