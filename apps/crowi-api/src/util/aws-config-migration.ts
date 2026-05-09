import Debug from 'debug';
import type Crowi from 'src/crowi';

const debug = Debug('crowi:util:aws-config-migration');

/**
 * One-shot migration from the legacy `upload:aws:*` config namespace to
 * the new `plugin:@crowi/plugin-aws:*` namespace, run on every server
 * boot from `Crowi.init()` *before* `setupPlugins()`.
 *
 * Why on every boot?
 *   - It's idempotent: target keys are written only when empty / missing.
 *     Re-running is a cheap series of in-memory checks plus zero writes.
 *   - It must complete before `setupPlugins()` runs, because plugins read
 *     their config at register-time (`ctx.dependencyConfig('@crowi/plugin-aws')`)
 *     and the @crowi/plugin-aws plugin's storage driver (`@crowi/plugin-storage-aws-s3`)
 *     pulls credentials out at that point.
 *
 * Why copy and not move?
 *   - Operators may need to roll back. Leaving the legacy keys in place
 *     means a downgrade still finds its config. Cleanup of the legacy
 *     keys is a follow-up task once the new namespace has been verified
 *     in production.
 *
 * Why not decrypt + re-encrypt the secret?
 *   - Both `crowi:upload:aws:secretAccessKey` (legacy) and
 *     `crowi:plugin:@crowi/plugin-aws:secretAccessKey` (new) are sensitive
 *     under the *same* AES-256-GCM key. We read the value through
 *     `Config.loadAllConfig()` which decrypts on the way out, then write
 *     it back through `configService.saveConfig` which re-encrypts on the
 *     way in. The plaintext only ever exists in memory for the duration
 *     of this function.
 *
 * Returns the number of keys actually migrated (0 ≤ n ≤ 4) so the boot
 * log can advertise the migration without spamming on every restart.
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

  // (legacy key, new key) pairs. The new key set lives under the
  // PluginManager's `plugin:<name>:` prefix and is what `@crowi/plugin-aws`
  // reads via `ctx.config<AwsConfig>()`.
  const pairs: { legacy: string; next: string }[] = [
    { legacy: 'upload:aws:region', next: 'plugin:@crowi/plugin-aws:region' },
    { legacy: 'upload:aws:accessKeyId', next: 'plugin:@crowi/plugin-aws:accessKeyId' },
    { legacy: 'upload:aws:secretAccessKey', next: 'plugin:@crowi/plugin-aws:secretAccessKey' },
    // The S3 bucket lives under `@crowi/plugin-storage-aws-s3` (not
    // `@crowi/plugin-aws`) because it's S3-specific config rather than
    // shared AWS credentials. Migrate it into the matching namespace so
    // the storage driver picks it up.
    { legacy: 'upload:aws:bucket', next: 'plugin:@crowi/plugin-storage-aws-s3:bucket' },
  ];

  const updates: Record<string, unknown> = {};
  for (const { legacy, next } of pairs) {
    const legacyValue = ns[legacy];
    if (!hasMeaningfulValue(legacyValue)) continue; // nothing to copy
    const nextValue = ns[next];
    if (hasMeaningfulValue(nextValue)) continue; // operator already set the new key — never overwrite
    updates[next] = legacyValue;
  }

  if (Object.keys(updates).length === 0) {
    debug('no aws keys to migrate');
    return 0;
  }

  await crowi.getConfigService().saveConfig('crowi', updates);
  console.log(`[crowi] Migrated ${Object.keys(updates).length} legacy upload:aws:* config key(s) into the plugin namespace.`);
  debug('migrated keys: %o', Object.keys(updates));
  return Object.keys(updates).length;
}

/**
 * Treat empty strings, null, and undefined as "no value set" so the
 * migration doesn't carry forward defaults that were never actually
 * configured. Booleans / numbers (which `upload:aws:*` keys never use)
 * pass through as meaningful.
 */
function hasMeaningfulValue(value: unknown): boolean {
  if (value === null || value === undefined) return false;
  if (typeof value === 'string' && value === '') return false;
  return true;
}
