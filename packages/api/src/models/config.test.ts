import crypto from 'crypto';
import { crowi, Fixture } from 'src/test/setup';
import { isEncrypted, resetKeyProvider } from 'src/util/crypto';

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
      await Config.deleteByParams('crowi', 'google:clientSecret');
      await Config.deleteByParams('crowi', 'mail:smtpPassword');
    });

    test('sensitive values are written encrypted and read back as plaintext', async () => {
      const secret = 'super-secret-google-secret';
      await Config.updateConfig('crowi', 'google:clientSecret', secret);

      const stored = await Config.findOne({ ns: 'crowi', key: 'google:clientSecret' }).exec();
      expect(stored).not.toBeNull();
      expect(isEncrypted(stored!.value)).toBe(true);

      const config = await Config.loadAllConfig();
      expect(config.crowi['google:clientSecret']).toBe(secret);
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
  });

  describe('.migrate', () => {
    const bucket = 'crowi';
    const region = 'ap-northeast-1';
    const accessKeyId = 'XXXX';
    const secretAccessKey = 'YYYY';

    beforeAll(async () => {
      await Fixture.generate('Config', [
        { ns: 'crowi', key: 'aws:bucket', value: JSON.stringify(bucket) },
        { ns: 'crowi', key: 'aws:region', value: JSON.stringify(region) },
        { ns: 'crowi', key: 'aws:accessKeyId', value: JSON.stringify(accessKeyId) },
        { ns: 'crowi', key: 'aws:secretAccessKey', value: JSON.stringify(secretAccessKey) },
      ]);
    });

    test('Migrate config correctly', async function () {
      await Config.migrate();
      const config = await Config.loadAllConfig();

      expect(config.crowi).toHaveProperty('upload:aws:bucket', bucket);
      expect(config.crowi).toHaveProperty('upload:aws:region', region);
      expect(config.crowi).toHaveProperty('upload:aws:accessKeyId', accessKeyId);
      expect(config.crowi).toHaveProperty('upload:aws:secretAccessKey', secretAccessKey);
    });
  });
});
