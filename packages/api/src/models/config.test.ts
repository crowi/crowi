import crypto from 'crypto';
import { crowi, Fixture } from 'src/test/setup';
import { registerSensitiveConfigKeys, resetRuntimeSensitiveConfigKeys } from 'src/models/config-sensitive';
import { isEncrypted, resetKeyProvider } from 'src/util/crypto';

const ATOMIC_GOOGLE_KEY = 'plugin:@crowi/plugin-google:__atomic:clientCredentials';

describe('Config model test', () => {
  let Config;

  beforeAll((done) => {
    Config = crowi.model('Config');

    const fixtures = [
      { ns: 'crowi', key: 'test:test', value: JSON.stringify('crowi test value') },
      { ns: 'crowi', key: 'test:test2', value: JSON.stringify(11111) },
      { ns: 'crowi', key: 'test:test3', value: JSON.stringify([1, 2, 3, 4, 5]) },
      { ns: 'plugin', key: 'other:config', value: JSON.stringify('this is data') },
    ];

    Fixture.generate('Config', fixtures)
      .then(function (configs) {
        done();
      })
      .catch(function () {
        done(new Error('Skip this test.'));
      });
  });

  describe('.CONSTANTS', () => {
    test('Config has constants', () => {
      expect(Config.SECURITY_REGISTRATION_MODE_OPEN).toBe('Open');
      expect(Config.SECURITY_REGISTRATION_MODE_RESTRICTED).toBe('Resricted');
      expect(Config.SECURITY_REGISTRATION_MODE_CLOSED).toBe('Closed');
    });
  });

  describe('.loadAllConfig', () => {
    test('Get config array', async function () {
      const config = await Config.loadAllConfig();
      expect(config.crowi).toHaveProperty('test:test', 'crowi test value');
      expect(config.crowi).toHaveProperty('test:test2', 11111);
      expect(config.crowi).toHaveProperty('test:test3', [1, 2, 3, 4, 5]);

      expect(config.plugin).toHaveProperty('other:config', 'this is data');
    });
  });

  describe('write durability (feature-config-write-durability)', () => {
    afterEach(() => {
      jest.restoreAllMocks();
    });

    test('AC-1: updateConfig propagates a write failure instead of swallowing it', async () => {
      jest.spyOn(Config, 'updateByParams').mockRejectedValueOnce(new Error('mongo write failed'));

      await expect(Config.updateConfig('crowi', 'durability:single', 'value')).rejects.toThrow('mongo write failed');
    });

    test('AC-1/AC-2: updateConfigByNamespace waits for every key to settle before throwing, and a key that succeeded stays persisted while the failed one does not', async () => {
      await Config.deleteMany({ ns: 'crowi', key: { $in: ['durability:a', 'durability:b'] } }).exec();

      let releaseB: (() => void) | undefined;
      const bGate = new Promise<void>((resolve) => {
        releaseB = resolve;
      });
      let bWritten = false;

      const originalUpdateByParams = Config.updateByParams.bind(Config);
      jest.spyOn(Config, 'updateByParams').mockImplementation(async (ns: string, key: string, value: string) => {
        if (key === 'durability:a') {
          throw new Error('mongo write failed: a');
        }
        if (key === 'durability:b') {
          // Held open deliberately: this is what distinguishes
          // Promise.allSettled from Promise.all. Under Promise.all the
          // rejection above would win the race and the overall call would
          // already have rejected by the time this resolves; under
          // Promise.allSettled the call must still be pending here.
          await bGate;
          await originalUpdateByParams(ns, key, value);
          bWritten = true;
          return;
        }
        return originalUpdateByParams(ns, key, value);
      });

      const pending = Config.updateConfigByNamespace('crowi', {
        'durability:a': 'a-value',
        'durability:b': 'b-value',
      });
      let settled = false;
      pending.catch(() => {
        settled = true;
      });

      // Let key a's rejection's microtasks flush; the wrapper call must
      // still be unsettled because key b has not been released yet.
      await new Promise((resolve) => setImmediate(resolve));
      expect(settled).toBe(false);
      expect(bWritten).toBe(false);

      releaseB!();
      await expect(pending).rejects.toThrow('mongo write failed: a');
      expect(bWritten).toBe(true);

      const [aRow, bRow] = await Promise.all([
        Config.findOne({ ns: 'crowi', key: 'durability:a' }).exec(),
        Config.findOne({ ns: 'crowi', key: 'durability:b' }).exec(),
      ]);
      expect(aRow).toBeNull();
      expect(bRow).not.toBeNull();

      await Config.deleteMany({ ns: 'crowi', key: { $in: ['durability:a', 'durability:b'] } }).exec();
    });

    test('AC-8: applicationInstall does not return successfully when the seeding write fails', async () => {
      // The fixtures seeded in beforeAll already populate `ns: 'crowi'`,
      // which would make applicationInstall throw its OWN "already
      // installed" guard before ever attempting a write — clear it so the
      // injected write failure is what actually gets exercised, then
      // restore the fixture rows for the rest of the file.
      const existingCrowiRows = await Config.find({ ns: 'crowi' }).lean().exec();
      await Config.deleteMany({ ns: 'crowi' }).exec();

      try {
        jest.spyOn(Config, 'updateByParams').mockRejectedValueOnce(new Error('mongo write failed during install'));

        await expect(Config.applicationInstall()).rejects.toThrow('mongo write failed during install');
      } finally {
        await Config.deleteMany({ ns: 'crowi' }).exec();
        if (existingCrowiRows.length > 0) {
          await Config.insertMany(existingCrowiRows);
        }
      }
    });
  });

  describe('encryption of sensitive values', () => {
    const originalKey = process.env.CROWI_ENCRYPTION_KEY;

    beforeAll(() => {
      process.env.CROWI_ENCRYPTION_KEY = crypto.randomBytes(32).toString('base64');
      resetKeyProvider();
    });

    afterAll(async () => {
      if (originalKey === undefined) {
        delete process.env.CROWI_ENCRYPTION_KEY;
      } else {
        process.env.CROWI_ENCRYPTION_KEY = originalKey;
      }
      resetKeyProvider();
      // Clean up so other tests don't see the encrypted rows.
      await Config.deleteByParams('notification', 'slack:token');
      await Config.deleteByParams('crowi', 'mail:smtpPassword');
    });

    test('sensitive values are written encrypted and read back as plaintext', async () => {
      const secret = 'super-secret-slack-secret';
      await Config.updateConfig('notification', 'slack:token', secret);

      const stored = await Config.findOne({ ns: 'notification', key: 'slack:token' }).exec();
      expect(stored).not.toBeNull();
      expect(isEncrypted(stored!.value)).toBe(true);

      const config = await Config.loadAllConfig();
      expect(config.notification['slack:token']).toBe(secret);
    });

    test('legacy plaintext rows for sensitive keys are still readable (back-compat)', async () => {
      // Pretend an existing deployment already had this value stored unencrypted.
      await Config.findOneAndUpdate(
        { ns: 'crowi', key: 'mail:smtpPassword' },
        { ns: 'crowi', key: 'mail:smtpPassword', value: JSON.stringify('legacy-plain-password') },
        { upsert: true },
      ).exec();

      const config = await Config.loadAllConfig();
      expect(config.crowi['mail:smtpPassword']).toBe('legacy-plain-password');
    });

    describe('atomic plugin config groups (RFC-0014 phase 4)', () => {
      beforeAll(() => {
        // At boot `PluginManager.listSensitiveKeys()` registers the GROUP's
        // physical key (never the member fields, which have no row of their
        // own) — mirrored here so encryption behaves as it does in
        // production.
        registerSensitiveConfigKeys([`crowi:${ATOMIC_GOOGLE_KEY}`]);
      });

      afterAll(() => {
        resetRuntimeSensitiveConfigKeys();
      });

      afterEach(async () => {
        // Cleaned up per case, not at the end of each test body: a failing
        // assertion would otherwise leak the row into the next case.
        await Config.deleteByParams('crowi', ATOMIC_GOOGLE_KEY);
        await Config.deleteByParams('crowi', 'google:clientId');
      });

      test('AC-2: an atomic credential group is stored as ONE encrypted document and read back as flat fields', async () => {
        await Config.updateAtomicConfigGroup('crowi', '@crowi/plugin-google', 'clientCredentials', {
          clientId: 'client-id.apps.googleusercontent.com',
          clientSecret: 'super-secret-google-secret',
        });

        // One physical row, and no per-field rows beside it: a separate
        // `clientId` row is exactly the half-written state this shape exists
        // to prevent.
        const rows = await Config.find({ ns: 'crowi', key: /^plugin:@crowi\/plugin-google:/ }).exec();
        expect(rows).toHaveLength(1);
        expect(rows[0].key).toBe('plugin:@crowi/plugin-google:__atomic:clientCredentials');
        expect(isEncrypted(rows[0].value)).toBe(true);
        // The secret must not be sitting in the document in the clear.
        expect(rows[0].value).not.toContain('super-secret-google-secret');

        // Consumers still see ordinary flat config — the group key itself is
        // a storage detail and never reaches runtime config.
        const config = await Config.loadAllConfig();
        expect(config.crowi['plugin:@crowi/plugin-google:clientId']).toBe('client-id.apps.googleusercontent.com');
        expect(config.crowi['plugin:@crowi/plugin-google:clientSecret']).toBe('super-secret-google-secret');
        expect(config.crowi['plugin:@crowi/plugin-google:__atomic:clientCredentials']).toBeUndefined();
      });

      test('AC-2: legacy google:* rows are left alone and never feed the plugin namespace', async () => {
        await Config.findOneAndUpdate(
          { ns: 'crowi', key: 'google:clientId' },
          { ns: 'crowi', key: 'google:clientId', value: JSON.stringify('legacy-v1-client-id') },
          { upsert: true },
        ).exec();

        const config = await Config.loadAllConfig();
        // Still readable as its own legacy key (we do not delete v1 rows)…
        expect(config.crowi['google:clientId']).toBe('legacy-v1-client-id');
        // …but it is not the Google plugin's config, which stays unset.
        expect(config.crowi['plugin:@crowi/plugin-google:clientId']).toBeUndefined();
      });

      test('AC-2: a malformed atomic payload fails the load instead of degrading to a partial expansion', async () => {
        // Silently dropping a malformed group would hand the plugin half a
        // credential pair — precisely the state the atomic document exists to
        // make unrepresentable — so `loadAllConfig` must refuse outright.
        await Config.findOneAndUpdate(
          { ns: 'crowi', key: 'plugin:@crowi/plugin-google:__atomic:clientCredentials' },
          { ns: 'crowi', key: 'plugin:@crowi/plugin-google:__atomic:clientCredentials', value: JSON.stringify('not-an-object') },
          { upsert: true },
        ).exec();

        await expect(Config.loadAllConfig()).rejects.toThrow(/atomic group 'clientCredentials'/);

        await Config.findOneAndUpdate(
          { ns: 'crowi', key: 'plugin:@crowi/plugin-google:__atomic:clientCredentials' },
          { ns: 'crowi', key: 'plugin:@crowi/plugin-google:__atomic:clientCredentials', value: JSON.stringify({ clientId: 'ok', clientSecret: 42 }) },
          { upsert: true },
        ).exec();

        await expect(Config.loadAllConfig()).rejects.toThrow(/non-string value for 'clientSecret'/);
      });
    });
  });
});
