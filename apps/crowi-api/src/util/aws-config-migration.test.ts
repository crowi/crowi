import { runAwsConfigMigration } from 'src/util/aws-config-migration';
import { crowi } from 'src/test/setup';

/**
 * Reset every legacy + plugin AWS key between cases so each one starts
 * from a known empty state. Uses the configService (rather than poking
 * Mongo directly) so the in-memory cache stays consistent.
 */
const resetAwsConfig = async () => {
  await crowi.getConfigService().saveConfig('crowi', {
    'upload:aws:region': '',
    'upload:aws:bucket': '',
    'upload:aws:accessKeyId': '',
    'upload:aws:secretAccessKey': '',
    'plugin:@crowi/plugin-aws:region': '',
    'plugin:@crowi/plugin-aws:accessKeyId': '',
    'plugin:@crowi/plugin-aws:secretAccessKey': '',
    'plugin:@crowi/plugin-storage-aws-s3:bucket': '',
  });
};

describe('util/aws-config-migration', () => {
  beforeEach(async () => {
    await resetAwsConfig();
  });

  test('copies legacy upload:aws:* keys when target plugin keys are empty', async () => {
    await crowi.getConfigService().saveConfig('crowi', {
      'upload:aws:region': 'ap-northeast-1',
      'upload:aws:bucket': 'legacy-bucket',
      'upload:aws:accessKeyId': 'AKIA-LEGACY',
      'upload:aws:secretAccessKey': 'super-secret',
    });

    const migrated = await runAwsConfigMigration(crowi);

    expect(migrated).toBe(4);
    const ns = crowi.getConfig().crowi;
    expect(ns['plugin:@crowi/plugin-aws:region']).toBe('ap-northeast-1');
    expect(ns['plugin:@crowi/plugin-aws:accessKeyId']).toBe('AKIA-LEGACY');
    expect(ns['plugin:@crowi/plugin-aws:secretAccessKey']).toBe('super-secret');
    expect(ns['plugin:@crowi/plugin-storage-aws-s3:bucket']).toBe('legacy-bucket');
  });

  test('leaves legacy keys in place after copying (rollback safety)', async () => {
    await crowi.getConfigService().saveConfig('crowi', {
      'upload:aws:region': 'us-east-1',
      'upload:aws:accessKeyId': 'AKIA-KEEP',
    });

    await runAwsConfigMigration(crowi);

    const ns = crowi.getConfig().crowi;
    expect(ns['upload:aws:region']).toBe('us-east-1');
    expect(ns['upload:aws:accessKeyId']).toBe('AKIA-KEEP');
  });

  test('does not overwrite plugin keys that already have values', async () => {
    await crowi.getConfigService().saveConfig('crowi', {
      'upload:aws:region': 'legacy-region',
      'upload:aws:accessKeyId': 'AKIA-LEGACY',
      'plugin:@crowi/plugin-aws:region': 'plugin-region', // already set
      'plugin:@crowi/plugin-aws:accessKeyId': '', // empty → still gets migrated
    });

    const migrated = await runAwsConfigMigration(crowi);

    // Only accessKeyId is migrated; region is left alone.
    expect(migrated).toBe(1);
    const ns = crowi.getConfig().crowi;
    expect(ns['plugin:@crowi/plugin-aws:region']).toBe('plugin-region');
    expect(ns['plugin:@crowi/plugin-aws:accessKeyId']).toBe('AKIA-LEGACY');
  });

  test('is a no-op when no legacy keys are set', async () => {
    const migrated = await runAwsConfigMigration(crowi);
    expect(migrated).toBe(0);
  });

  test('skips empty-string legacy values (treated as "not configured")', async () => {
    await crowi.getConfigService().saveConfig('crowi', {
      'upload:aws:region': '', // explicit empty, not a real value
      'upload:aws:accessKeyId': 'AKIA-REAL',
    });

    const migrated = await runAwsConfigMigration(crowi);

    expect(migrated).toBe(1);
    const ns = crowi.getConfig().crowi;
    expect(ns['plugin:@crowi/plugin-aws:region']).toBe('');
    expect(ns['plugin:@crowi/plugin-aws:accessKeyId']).toBe('AKIA-REAL');
  });

  test('idempotent — running twice yields zero on the second pass', async () => {
    await crowi.getConfigService().saveConfig('crowi', {
      'upload:aws:region': 'ap-northeast-1',
      'upload:aws:bucket': 'a-bucket',
    });

    expect(await runAwsConfigMigration(crowi)).toBe(2);
    expect(await runAwsConfigMigration(crowi)).toBe(0);
  });
});
