import crypto from 'crypto';
import request from 'supertest';
import { app, crowi, Fixture } from 'src/test/setup';
import { createJwtUtil } from 'src/util/jwt';
import { isEncrypted, resetKeyProvider } from 'src/util/crypto';

const authHeaders = (token: string) => ({
  Authorization: `Bearer ${token}`,
  'Content-Type': 'application/json',
});

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

describe('Routes /api/v2/admin/mail (ts-rest)', () => {
  let Config;
  let adminToken: string;
  let adminEmail: string;
  let memberToken: string;
  const originalKey = process.env.CROWI_ENCRYPTION_KEY;

  const MAIL_KEYS = [
    'mail:from',
    'mail:smtpHost',
    'mail:smtpPort',
    'mail:smtpUser',
    'mail:smtpPassword',
    'mail:aws:region',
    'mail:aws:accessKeyId',
    'mail:aws:secretAccessKey',
  ];

  beforeAll(async () => {
    Config = crowi.model('Config');
    process.env.CROWI_ENCRYPTION_KEY = crypto.randomBytes(32).toString('base64');
    resetKeyProvider();

    const admin = await createUser({ name: 'Mail Admin', username: 'mailAdmin', email: 'mail-admin@example.com' }, true);
    adminToken = admin.accessToken;
    adminEmail = admin.user.email;
    const member = await createUser({ name: 'Mail Member', username: 'mailMember', email: 'mail-member@example.com' }, false);
    memberToken = member.accessToken;
  });

  afterEach(async () => {
    await Config.deleteMany({ ns: 'crowi', key: { $in: MAIL_KEYS } });
    await reloadConfigCache();
  });

  afterAll(() => {
    if (originalKey === undefined) {
      delete process.env.CROWI_ENCRYPTION_KEY;
    } else {
      process.env.CROWI_ENCRYPTION_KEY = originalKey;
    }
    resetKeyProvider();
  });

  describe('GET /api/v2/admin/mail', () => {
    it('returns 401 without auth', async () => {
      const res = await request(app).get('/api/v2/admin/mail');
      expect(res.status).toBe(401);
      expect(res.body.error.code).toBe('AUTHENTICATION_REQUIRED');
    });

    it('returns 403 for a non-admin user', async () => {
      const res = await request(app).get('/api/v2/admin/mail').set(authHeaders(memberToken));
      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe('ADMIN_REQUIRED');
    });

    it('returns the current mail:* slice with secret masking', async () => {
      await Config.updateConfig('crowi', 'mail:from', 'noreply@example.com');
      await Config.updateConfig('crowi', 'mail:smtpHost', 'smtp.example.com');
      await Config.updateConfig('crowi', 'mail:smtpPort', 587);
      await Config.updateConfig('crowi', 'mail:smtpUser', 'smtp-user');
      await Config.updateConfig('crowi', 'mail:smtpPassword', 'smtp-secret');
      await Config.updateConfig('crowi', 'mail:aws:region', 'ap-northeast-1');
      await Config.updateConfig('crowi', 'mail:aws:accessKeyId', 'AKIAFAKE');
      await Config.updateConfig('crowi', 'mail:aws:secretAccessKey', 'aws-secret');
      await reloadConfigCache();

      const res = await request(app).get('/api/v2/admin/mail').set(authHeaders(adminToken));
      expect(res.status).toBe(200);
      expect(res.body).toEqual({
        from: 'noreply@example.com',
        smtpHost: 'smtp.example.com',
        smtpPort: 587,
        smtpUser: 'smtp-user',
        smtpPassword: { hasValue: true },
        aws: {
          region: 'ap-northeast-1',
          accessKeyId: 'AKIAFAKE',
          secretAccessKey: { hasValue: true },
        },
      });
      expect(JSON.stringify(res.body)).not.toContain('smtp-secret');
      expect(JSON.stringify(res.body)).not.toContain('aws-secret');
    });

    it('reports hasValue=false when secrets are empty', async () => {
      await Config.updateConfig('crowi', 'mail:smtpPassword', '');
      await Config.updateConfig('crowi', 'mail:aws:secretAccessKey', '');
      await reloadConfigCache();

      const res = await request(app).get('/api/v2/admin/mail').set(authHeaders(adminToken));
      expect(res.status).toBe(200);
      expect(res.body.smtpPassword).toEqual({ hasValue: false });
      expect(res.body.aws.secretAccessKey).toEqual({ hasValue: false });
    });

    it('returns smtpPort=0 when not yet set', async () => {
      const res = await request(app).get('/api/v2/admin/mail').set(authHeaders(adminToken));
      expect(res.status).toBe(200);
      expect(res.body.smtpPort).toBe(0);
    });
  });

  describe('PUT /api/v2/admin/mail', () => {
    it('returns 401 without auth', async () => {
      const res = await request(app).put('/api/v2/admin/mail').send({ from: 'a@example.com' });
      expect(res.status).toBe(401);
    });

    it('returns 403 for a non-admin user', async () => {
      const res = await request(app).put('/api/v2/admin/mail').set(authHeaders(memberToken)).send({ from: 'a@example.com' });
      expect(res.status).toBe(403);
    });

    it('persists fields and round-trips via GET', async () => {
      const res = await request(app)
        .put('/api/v2/admin/mail')
        .set(authHeaders(adminToken))
        .send({
          from: 'noreply@example.com',
          smtpHost: 'smtp.example.com',
          smtpPort: 587,
          smtpUser: 'smtp-user',
          smtpPassword: 'rt-smtp-secret',
          aws: {
            region: 'us-east-1',
            accessKeyId: 'AKIA12345',
            secretAccessKey: 'rt-aws-secret',
          },
        });

      expect(res.status).toBe(200);
      expect(res.body).toEqual({ ok: true });

      const get = await request(app).get('/api/v2/admin/mail').set(authHeaders(adminToken));
      expect(get.status).toBe(200);
      expect(get.body).toEqual({
        from: 'noreply@example.com',
        smtpHost: 'smtp.example.com',
        smtpPort: 587,
        smtpUser: 'smtp-user',
        smtpPassword: { hasValue: true },
        aws: {
          region: 'us-east-1',
          accessKeyId: 'AKIA12345',
          secretAccessKey: { hasValue: true },
        },
      });
    });

    it('rejects invalid AWS region with 400', async () => {
      const res = await request(app)
        .put('/api/v2/admin/mail')
        .set(authHeaders(adminToken))
        .send({ aws: { region: 'tokyo' } });
      expect(res.status).toBe(400);
    });

    it('rejects out-of-range smtpPort with 400', async () => {
      const res = await request(app).put('/api/v2/admin/mail').set(authHeaders(adminToken)).send({ smtpPort: 0 });
      expect(res.status).toBe(400);
    });

    it('leaves smtpPassword untouched when omitted', async () => {
      await Config.updateConfig('crowi', 'mail:smtpPassword', 'pre-existing');
      await reloadConfigCache();

      const res = await request(app).put('/api/v2/admin/mail').set(authHeaders(adminToken)).send({ smtpHost: 'smtp.example.com' });
      expect(res.status).toBe(200);

      const cfg = await Config.loadAllConfig();
      expect(cfg.crowi['mail:smtpPassword']).toBe('pre-existing');
    });

    it('clears smtpPassword when set to empty string', async () => {
      await Config.updateConfig('crowi', 'mail:smtpPassword', 'will-be-cleared');
      await reloadConfigCache();

      const res = await request(app).put('/api/v2/admin/mail').set(authHeaders(adminToken)).send({ smtpPassword: '' });
      expect(res.status).toBe(200);

      const cfg = await Config.loadAllConfig();
      expect(cfg.crowi['mail:smtpPassword']).toBe('');
    });

    it('encrypts smtpPassword at rest when CROWI_ENCRYPTION_KEY is set', async () => {
      const res = await request(app).put('/api/v2/admin/mail').set(authHeaders(adminToken)).send({ smtpPassword: 'plaintext-smtp-pw' });
      expect(res.status).toBe(200);

      const stored = await Config.findOne({ ns: 'crowi', key: 'mail:smtpPassword' }).exec();
      expect(stored).not.toBeNull();
      expect(isEncrypted(stored.value)).toBe(true);
      expect(stored.value).not.toContain('plaintext-smtp-pw');

      const cfg = await Config.loadAllConfig();
      expect(cfg.crowi['mail:smtpPassword']).toBe('plaintext-smtp-pw');
    });

    it('encrypts aws.secretAccessKey at rest', async () => {
      const res = await request(app)
        .put('/api/v2/admin/mail')
        .set(authHeaders(adminToken))
        .send({ aws: { secretAccessKey: 'plaintext-aws-secret' } });
      expect(res.status).toBe(200);

      const stored = await Config.findOne({ ns: 'crowi', key: 'mail:aws:secretAccessKey' }).exec();
      expect(stored).not.toBeNull();
      expect(isEncrypted(stored.value)).toBe(true);
      expect(stored.value).not.toContain('plaintext-aws-secret');
    });

    it('accepts an empty body and is a no-op', async () => {
      const before = await Config.countDocuments({ ns: 'crowi' }).exec();
      const res = await request(app).put('/api/v2/admin/mail').set(authHeaders(adminToken)).send({});
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ ok: true });
      const after = await Config.countDocuments({ ns: 'crowi' }).exec();
      expect(after).toBe(before);
    });
  });

  describe('POST /api/v2/admin/mail/test', () => {
    let originalCreateSMTPClient: ((option?: unknown) => unknown) | undefined;
    let sendMailMock: jest.Mock;
    let createTransportSpy: jest.Mock;

    beforeEach(() => {
      sendMailMock = jest.fn((_opts, cb: (err: Error | null) => void) => cb(null));
      createTransportSpy = jest.fn(() => ({ sendMail: sendMailMock }));

      // Swap createSMTPClient on the live mailer with a stub that returns our
      // mocked transport. Avoiding jest.mock on `nodemailer` keeps the rest of
      // the test setup (which boots Crowi once and shares the mailer) intact.
      originalCreateSMTPClient = crowi.mailer.createSMTPClient;
      crowi.mailer.createSMTPClient = (option: unknown) => createTransportSpy(option);
    });

    afterEach(() => {
      if (originalCreateSMTPClient) {
        crowi.mailer.createSMTPClient = originalCreateSMTPClient;
      }
    });

    it('returns 401 without auth', async () => {
      const res = await request(app).post('/api/v2/admin/mail/test').send({});
      expect(res.status).toBe(401);
    });

    it('returns 403 for a non-admin user', async () => {
      const res = await request(app).post('/api/v2/admin/mail/test').set(authHeaders(memberToken)).send({});
      expect(res.status).toBe(403);
    });

    it('sends a test mail via SMTP using the body-supplied option', async () => {
      const res = await request(app).post('/api/v2/admin/mail/test').set(authHeaders(adminToken)).send({
        smtpHost: 'smtp.example.com',
        smtpPort: 587,
        smtpUser: 'u',
        smtpPassword: 'p',
      });

      expect(res.status).toBe(200);
      expect(res.body).toEqual({ ok: true, to: adminEmail });

      expect(createTransportSpy).toHaveBeenCalledTimes(1);
      const passedOption = createTransportSpy.mock.calls[0][0];
      expect(passedOption).toEqual(
        expect.objectContaining({
          host: 'smtp.example.com',
          port: 587,
          auth: { user: 'u', pass: 'p' },
        }),
      );

      expect(sendMailMock).toHaveBeenCalledTimes(1);
      const mailArg = sendMailMock.mock.calls[0][0];
      expect(mailArg).toEqual(
        expect.objectContaining({
          to: adminEmail,
          subject: 'Wiki管理設定のアップデートによるメール通知',
          text: 'このメールは、WikiのSMTP設定のアップデートにより送信されています。',
        }),
      );
    });

    it('marks the transport secure when port is 465', async () => {
      const res = await request(app).post('/api/v2/admin/mail/test').set(authHeaders(adminToken)).send({ smtpHost: 'smtp.example.com', smtpPort: 465 });

      expect(res.status).toBe(200);
      const passedOption = createTransportSpy.mock.calls[0][0];
      expect(passedOption).toEqual(expect.objectContaining({ host: 'smtp.example.com', port: 465, secure: true }));
    });

    it('falls back to saved config when body is omitted', async () => {
      await Config.updateConfig('crowi', 'mail:smtpHost', 'saved.example.com');
      await Config.updateConfig('crowi', 'mail:smtpPort', 25);
      await reloadConfigCache();

      const res = await request(app).post('/api/v2/admin/mail/test').set(authHeaders(adminToken)).send({});

      expect(res.status).toBe(200);
      const passedOption = createTransportSpy.mock.calls[0][0];
      expect(passedOption).toEqual(expect.objectContaining({ host: 'saved.example.com', port: 25 }));
    });

    it('returns 502 when SMTP host / port is missing', async () => {
      const res = await request(app).post('/api/v2/admin/mail/test').set(authHeaders(adminToken)).send({});

      expect(res.status).toBe(502);
      expect(res.body.error.code).toBe('MAIL_TEST_FAILED');
      expect(sendMailMock).not.toHaveBeenCalled();
    });

    it('returns 502 with the underlying message when sendMail fails', async () => {
      sendMailMock.mockImplementationOnce((_opts, cb: (err: Error | null) => void) => cb(new Error('connect ECONNREFUSED')));

      const res = await request(app).post('/api/v2/admin/mail/test').set(authHeaders(adminToken)).send({ smtpHost: 'smtp.example.com', smtpPort: 587 });

      expect(res.status).toBe(502);
      expect(res.body.error).toEqual({ code: 'MAIL_TEST_FAILED', message: 'connect ECONNREFUSED' });
    });
  });
});
