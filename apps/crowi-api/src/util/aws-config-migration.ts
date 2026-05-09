import Debug from 'debug';
import type Crowi from 'src/crowi';

const debug = Debug('crowi:util:aws-config-migration');

/**
 * Copy legacy `upload:aws:*` config into the new plugin namespace
 * (`plugin:@crowi/plugin-aws:*` and `plugin:@crowi/plugin-storage-aws-s3:bucket`).
 * Idempotent: target keys are written only when empty / missing. Returns
 * the number of keys actually migrated.
 *
 * The legacy keys are kept in place so a downgrade still finds its config;
 * cleanup is a follow-up once the new namespace is verified in production.
 */
export async function runAwsConfigMigration(crowi: Crowi): Promise<number> {
  const cfg = crowi.getConfig();
  if (!cfg || typeof cfg !== 'object') {
    debug('config not loaded yet, skipping aws migration');
    return 0;
  }
  const ns = (cfg as { crowi?: Record<string, unknown> }).crowi;
  if (!ns) {
    debug('crowi namespace missing, skipping aws migration');
    return 0;
  }

  const pairs: { legacy: string; next: string }[] = [
    { legacy: 'upload:aws:region', next: 'plugin:@crowi/plugin-aws:region' },
    { legacy: 'upload:aws:accessKeyId', next: 'plugin:@crowi/plugin-aws:accessKeyId' },
    { legacy: 'upload:aws:secretAccessKey', next: 'plugin:@crowi/plugin-aws:secretAccessKey' },
    // The S3 bucket lives in the storage-aws-s3 plugin's own namespace
    // because it's S3-specific config rather than shared AWS credentials.
    { legacy: 'upload:aws:bucket', next: 'plugin:@crowi/plugin-storage-aws-s3:bucket' },
  ];

  const updates: Record<string, unknown> = {};
  for (const { legacy, next } of pairs) {
    const legacyValue = ns[legacy];
    if (!hasMeaningfulValue(legacyValue)) continue;
    if (hasMeaningfulValue(ns[next])) continue;
    updates[next] = legacyValue;
  }

  if (Object.keys(updates).length === 0) {
    debug('no aws keys to migrate');
    return 0;
  }

  // Write through the model directly to avoid `notifyUpdated()` which
  // would fire `setupSlack` / `setupMailer` — both run again a few lines
  // later in `Crowi.init()` anyway, and the redis pubsub may not be wired
  // yet at this point in boot.
  const Config = crowi.model('Config');
  await Config.updateConfigByNamespace('crowi', updates);
  Object.assign(ns, updates);

  console.log(`[crowi] Migrated ${Object.keys(updates).length} legacy upload:aws:* config key(s) into the plugin namespace.`);
  debug('migrated keys: %o', Object.keys(updates));
  return Object.keys(updates).length;
}

function hasMeaningfulValue(value: unknown): boolean {
  if (value === null || value === undefined) return false;
  if (typeof value === 'string' && value === '') return false;
  return true;
}
