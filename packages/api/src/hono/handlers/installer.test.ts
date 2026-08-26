import request from 'supertest';
import { app, crowi, INVALID_USERNAME_CASES } from 'src/test/setup';
import { type ConfigRow, restoreCrowiConfig, snapshotCrowiConfig } from 'src/test/config-snapshot';

/**
 * RFC-0006 Phase 4 Batch 1 — integration tests for the migrated
 * `installer` resource (`GET /api/installer`, `POST /api/installer/
 * createAdmin`).
 *
 * Wire-format parity with the ts-rest era is the explicit AC: the
 * status enum stays `'installer_required' | 'already_installed'`, the
 * create endpoint returns 200/400 with `{ status, message?, errors? }`,
 * and the public route is reachable without an Authorization header.
 *
 * The shared `crowi` from `src/test/setup` boots a Mongo-Memory-Server
 * with pre-seeded Config (so `isAppInstalled` reports `true` by
 * default). We restore that state in `afterEach` so individual `it()`s
 * can flip the install-flag locally without leaking state into
 * neighbours.
 */
describe('GET /api/installer (Hono)', () => {
  let Config: ReturnType<typeof crowi.model<'Config'>>;
  let User: ReturnType<typeof crowi.model<'User'>>;
  let configSnapshot: ConfigRow[];

  beforeAll(async () => {
    Config = crowi.model('Config');
    User = crowi.model('User');
    // The individual it()s flip the install flag (and the per-describe
    // afterEach wipes `ns:'crowi'` to reset within the file). Snapshot the
    // shared config here so the file-level afterAll can restore the namespace
    // to its as-discovered (installed) state — otherwise the last afterEach
    // leaves the shared config EMPTY and the next file sharing the test
    // database reads back an uninstalled/empty config → cross-file seed-401.
    configSnapshot = await snapshotCrowiConfig(crowi);
  });

  afterAll(async () => {
    await restoreCrowiConfig(crowi, configSnapshot);
  });

  describe('GET /installer', () => {
    afterEach(async () => {
      // Restore the pre-test state — strip every `{ ns: 'crowi' }` row
      // so the next test starts from `installer_required`. The
      // mongo-memory-server is per-worker so this can't leak across
      // workers, but it does leak across `it()`s in the same file.
      await Config.deleteMany({ ns: 'crowi' });
      await crowi.getConfigService().load();
    });

    it('returns already_installed when crowi config rows exist', async () => {
      await Config.applicationInstall();
      await crowi.getConfigService().load();

      const res = await request(app).get('/api/installer');
      expect(res.status).toBe(200);
      expect(res.headers['content-type']).toMatch(/application\/json/);
      expect(res.body).toEqual({ status: 'already_installed' });
    });

    it('returns installer_required when no crowi config rows exist', async () => {
      await Config.deleteMany({ ns: 'crowi' });
      const res = await request(app).get('/api/installer');
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ status: 'installer_required' });
    });

    it('does not require authentication (public route)', async () => {
      // No Authorization header set — would be 401 if the Hono mount
      // accidentally fell through to ts-rest's authenticatedRouter.
      const res = await request(app).get('/api/installer');
      expect(res.status).toBe(200);
    });
  });

  describe('POST /installer/createAdmin', () => {
    afterEach(async () => {
      await Config.deleteMany({ ns: 'crowi' });
      await crowi.getConfigService().load();
    });

    it('rejects when application is already installed (400 status=error)', async () => {
      await Config.applicationInstall();
      await crowi.getConfigService().load();

      const res = await request(app)
        .post('/api/installer/createAdmin')
        .send({
          registerForm: {
            name: 'Already Installed',
            username: 'already-installed',
            email: 'already-installed@example.com',
            password: 'Password!1',
          },
        });
      expect(res.status).toBe(400);
      expect(res.body).toEqual({ status: 'error', message: 'Application is already installed' });
    });

    it('creates the admin user and refreshes the install flag on success', async () => {
      // Start from the un-installed state to exercise the happy path.
      await Config.deleteMany({ ns: 'crowi' });
      await User.deleteMany({ email: 'installer-happy@example.com' });

      const res = await request(app)
        .post('/api/installer/createAdmin')
        .send({
          registerForm: {
            name: 'Installer Happy',
            username: 'installer-happy',
            email: 'installer-happy@example.com',
            password: 'Password!1',
          },
        });

      expect(res.status).toBe(200);
      expect(res.body).toEqual({ status: 'ok', message: 'Admin created successfully' });

      const adminUser = await User.findOne({ email: 'installer-happy@example.com' });
      expect(adminUser).not.toBeNull();
      expect(adminUser?.admin).toBe(true);

      // Calling `/installer` again must now report `already_installed`
      // — the handler refreshes ConfigService after writing.
      const status = await request(app).get('/api/installer');
      expect(status.body).toEqual({ status: 'already_installed' });

      await User.deleteMany({ email: 'installer-happy@example.com' });
    });

    // feature-config-reconciliation-safety — the admin user this request
    // created is real (createAdmin doesn't roll it back), and the
    // partially-seeded config rows are no longer deleted either: the
    // installer stays closed (reports `already_installed`) rather than
    // reopening to a fresh install after a seeding failure.
    it('AC-1/AC-4: installer does not reopen after a seeding write failure during createAdmin — partial config remains and the error names the recovery step', async () => {
      await Config.deleteMany({ ns: 'crowi' });
      await User.deleteMany({ email: 'installer-seed-fail@example.com' });

      jest.spyOn(Config, 'updateByParams').mockRejectedValueOnce(new Error('mongo write failed during install'));

      try {
        const res = await request(app)
          .post('/api/installer/createAdmin')
          .send({
            registerForm: {
              name: 'Seed Fail',
              username: 'installer-seed-fail',
              email: 'installer-seed-fail@example.com',
              password: 'Password!1',
            },
          });

        // Legacy parity: a failure inside the try/catch still comes back
        // as HTTP 200 + `status: 'error'`, not a 500 — the admin-creation
        // step itself did succeed, only seeding failed afterward.
        expect(res.status).toBe(200);
        expect(res.body.status).toBe('error');
        expect(res.body.errors?.[0]).toMatch(/mongo write failed during install/);
        expect(res.body.errors?.[0]).toMatch(/will not reopen/i);
        expect(res.body.errors?.[0]).toMatch(/recreate the database/i);

        // The partially-seeded rows remain — the installer stays closed
        // instead of reporting `installer_required` again.
        const status = await request(app).get('/api/installer');
        expect(status.body).toEqual({ status: 'already_installed' });
      } finally {
        jest.restoreAllMocks();
        await User.deleteMany({ email: 'installer-seed-fail@example.com' });
      }
    });

    // The count-based install guard is intentionally left unlocked (spec
    // §"やらないこと"). This test forces both concurrent requests past
    // every count-based guard (the handler's own `isAppInstalled`
    // pre-check AND `applicationInstall`'s internal one), regardless of
    // real write timing, so it exercises exactly one race deterministically:
    // one request's seeding WRITE fails while the other's genuinely
    // concurrent write succeeds. Without forcing the guards open, the two
    // requests' real Mongo timing can also make the second bounce off its
    // OWN guard once the first's rows have already landed — a second,
    // separate race (whether a concurrent installer even reaches the
    // seeding write before the other completes) that `models/config.test.ts`
    // (`AC-2`) already covers deterministically at the model level. Forcing
    // the guards open here isolates this test to the one thing AC-2/AC-3
    // actually assert: a completed install's configuration survives a
    // concurrent, failed seeding write.
    it("AC-2/AC-3: when two concurrent createAdmin requests race and one's seeding write fails, the other's completed configuration survives and already_installed persists", async () => {
      await Config.deleteMany({ ns: 'crowi' });
      await User.deleteMany({ email: { $in: ['installer-race-a@example.com', 'installer-race-b@example.com', 'installer-late@example.com'] } });

      const originalUpdateByParams = Config.updateByParams.bind(Config);
      let injected = false;
      jest.spyOn(Config, 'updateByParams').mockImplementation(async (ns: string, key: string, value: string) => {
        // Fails exactly one attempt's write of this key, whichever of the
        // two concurrent installs reaches it first — the other's write of
        // the same (identical) key still lands normally.
        if (key === 'app:confidential' && !injected) {
          injected = true;
          throw new Error('mongo write failed during concurrent install');
        }
        return originalUpdateByParams(ns, key, value);
      });
      jest.spyOn(Config, 'countDocuments').mockReturnValue({ exec: async () => 0 } as unknown as ReturnType<typeof Config.countDocuments>);

      try {
        const [resA, resB] = await Promise.all([
          request(app)
            .post('/api/installer/createAdmin')
            .send({ registerForm: { name: 'Race A', username: 'installer-race-a', email: 'installer-race-a@example.com', password: 'Password!1' } }),
          request(app)
            .post('/api/installer/createAdmin')
            .send({ registerForm: { name: 'Race B', username: 'installer-race-b', email: 'installer-race-b@example.com', password: 'Password!1' } }),
        ]);

        // Every count-based guard was forced open, so both requests reach
        // the seeding write and exactly one occurrence of it fails — the
        // split is now deterministic: one response completed, the other
        // carries the injected failure.
        const bodies = [resA.body, resB.body];
        expect(bodies.some((b) => b.status === 'ok')).toBe(true);
        expect(bodies.some((b) => typeof b.errors?.[0] === 'string' && /mongo write failed during concurrent install/.test(b.errors[0]))).toBe(true);

        // Restore real DB-backed guards before checking installed state —
        // the assertions below must reflect what actually landed, not the
        // forced-open guard.
        jest.restoreAllMocks();

        // The completed installer's configuration is not wiped by the
        // other's failure.
        const status = await request(app).get('/api/installer');
        expect(status.body).toEqual({ status: 'already_installed' });

        // And the public installer stays closed — it does not reopen.
        const createAfter = await request(app)
          .post('/api/installer/createAdmin')
          .send({ registerForm: { name: 'Late', username: 'installer-late', email: 'installer-late@example.com', password: 'Password!1' } });
        expect(createAfter.status).toBe(400);
        expect(createAfter.body).toEqual({ status: 'error', message: 'Application is already installed' });
      } finally {
        jest.restoreAllMocks();
        await User.deleteMany({ email: { $in: ['installer-race-a@example.com', 'installer-race-b@example.com', 'installer-late@example.com'] } });
      }
    });

    it('returns 400 (zod validation) when registerForm is missing required fields', async () => {
      await Config.deleteMany({ ns: 'crowi' });

      // username must match the shared `UsernameSchema` pattern
      // (`[A-Za-z0-9_-]{1,64}`) — an asterisk trips zod's validation and
      // the OpenAPIHono defaultHook turns it into a 400 `VALIDATION_ERROR`
      // envelope.
      const res = await request(app)
        .post('/api/installer/createAdmin')
        .send({
          registerForm: {
            name: 'Bad Form',
            username: '***bad***',
            email: 'bad-form@example.com',
            password: 'Password!1',
          },
        });

      expect(res.status).toBe(400);
      expect(res.body.error?.code).toBe('VALIDATION_ERROR');
    });

    // feature-username-validation-contract — the installer's `username`
    // field now shares `UsernameSchema` with self-registration and invite
    // acceptance. `.` was previously allowed here (a pre-existing
    // inconsistency) and is now rejected like everywhere else.
    describe('username validation (feature-username-validation-contract)', () => {
      afterEach(async () => {
        await Config.deleteMany({ ns: 'crowi' });
        await crowi.getConfigService().load();
      });

      it.each(INVALID_USERNAME_CASES)('rejects a username that is %s with 400 VALIDATION_ERROR', async (_label, username) => {
        await Config.deleteMany({ ns: 'crowi' });

        const res = await request(app)
          .post('/api/installer/createAdmin')
          .send({
            registerForm: {
              name: 'Bad Username',
              username,
              email: `installer-bad-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}@example.com`,
              password: 'Password!1',
            },
          });

        expect(res.status).toBe(400);
        expect(res.body.error?.code).toBe('VALIDATION_ERROR');
      });

      it('accepts a 1-character username at the lower boundary', async () => {
        await Config.deleteMany({ ns: 'crowi' });
        const email = 'installer-min-username@example.com';
        await User.deleteMany({ email });

        const res = await request(app)
          .post('/api/installer/createAdmin')
          .send({ registerForm: { name: 'Min Username', username: 'q', email, password: 'Password!1' } });

        expect(res.status).toBe(200);
        expect(res.body).toEqual({ status: 'ok', message: 'Admin created successfully' });

        const created = await User.findOne({ email });
        expect(created?.username).toBe('q');
        await User.deleteMany({ email });
      });

      it('accepts a 64-character username at the upper boundary', async () => {
        await Config.deleteMany({ ns: 'crowi' });
        const username = 'q'.repeat(64);
        const email = 'installer-max-username@example.com';
        await User.deleteMany({ $or: [{ email }, { username }] });

        const res = await request(app)
          .post('/api/installer/createAdmin')
          .send({ registerForm: { name: 'Max Username', username, email, password: 'Password!1' } });

        expect(res.status).toBe(200);
        expect(res.body).toEqual({ status: 'ok', message: 'Admin created successfully' });

        const created = await User.findOne({ email });
        expect(created?.username).toBe(username);
        await User.deleteMany({ $or: [{ email }, { username }] });
      });
    });
  });
});
