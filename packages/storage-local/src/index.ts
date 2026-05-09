import { createReadStream, createWriteStream, existsSync } from 'node:fs';
import { mkdir, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { z } from 'zod';
import type { CrowiPlugin, StorageDriver } from '@crowi/plugin-api';

/**
 * Local filesystem storage driver. Default-on plugin — auto-loaded
 * by `IMPLICIT_DEFAULT_PLUGINS` so a fresh Crowi install can store
 * uploads without any plugin configuration.
 *
 * Object keys are interpreted as filesystem paths under `rootDir`,
 * matching the v1.x layout (`data/uploads/<id>/<filename>`). Operators
 * upgrading from v1.x point `rootDir` at their existing `data/uploads/`
 * and files round-trip without migration.
 */

const LocalStorageConfigSchema = z
  .object({
    /**
     * Filesystem path where uploads live. Relative paths resolve
     * against the project root (the directory containing
     * `crowi.config.json`); absolute paths are used as-is.
     */
    rootDir: z.string().default('data/uploads'),
  })
  .strict();

type LocalStorageConfig = z.infer<typeof LocalStorageConfigSchema>;

const plugin: CrowiPlugin = {
  name: '@crowi/storage-local',
  version: '0.1.0-dev',
  configSchema: LocalStorageConfigSchema,
  adminPlacement: {
    label: 'ローカルストレージ',
    icon: 'hard-drive',
    // section omitted: derived from registerStorage → 'storage'
  },

  registerStorage: (registry, ctx) => {
    const driver: StorageDriver = createLocalDriver(ctx.config<LocalStorageConfig>());
    registry.register('local', driver);
    ctx.log.debug('registered local storage driver');
  },
};

export default plugin;

/**
 * Build the StorageDriver. Exported separately so the test suite can
 * exercise the implementation without going through PluginManager.
 */
export function createLocalDriver(config: LocalStorageConfig): StorageDriver {
  const root = path.isAbsolute(config.rootDir) ? config.rootDir : path.resolve(process.cwd(), config.rootDir);

  /**
   * Reject keys that would escape the root directory via `..` /
   * absolute paths. Without this check, a hostile caller could write
   * outside `rootDir` (e.g. `key = '../../../etc/passwd'`).
   */
  const resolveSafe = (key: string): string => {
    const resolved = path.resolve(root, key);
    if (resolved !== root && !resolved.startsWith(root + path.sep)) {
      throw new Error(`Storage key '${key}' resolves outside of rootDir`);
    }
    return resolved;
  };

  return {
    async put(key, body, _meta) {
      const target = resolveSafe(key);
      await mkdir(path.dirname(target), { recursive: true });
      const source = body instanceof Buffer ? Readable.from(body) : body;
      await pipeline(source, createWriteStream(target));
      return { key };
    },

    async get(key) {
      const target = resolveSafe(key);
      if (!existsSync(target)) {
        // Mimic the standard `ENOENT` error so callers can branch on it.
        // Use Object.assign instead of a property cast: tsup emits the
        // assign verbatim with no type info, which keeps the published
        // `dist/index.js` valid for ts-node when @crowi/api dev imports
        // this package. The cast form leaves a raw `err.code = …` in
        // the bundle and ts-node trips on `Property 'code' does not
        // exist on type 'Error'`.
        throw Object.assign(new Error(`Storage key '${key}' does not exist`), { code: 'ENOENT' });
      }
      return createReadStream(target);
    },

    async delete(key) {
      const target = resolveSafe(key);
      // rm with force: true is idempotent — no-op when the file is absent.
      await rm(target, { force: true });
    },

    // No signedUrl: local files are streamed via `get()` through the
    // API. Browsers cannot fetch them directly anyway.
  };
}

/**
 * Lightweight stat helper — useful for tests / debugging. Returns
 * null when the key does not exist.
 */
export async function statKey(driverConfig: LocalStorageConfig, key: string): Promise<{ size: number } | null> {
  const root = path.isAbsolute(driverConfig.rootDir) ? driverConfig.rootDir : path.resolve(process.cwd(), driverConfig.rootDir);
  const target = path.resolve(root, key);
  try {
    const s = await stat(target);
    return { size: s.size };
  } catch {
    return null;
  }
}
