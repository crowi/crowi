import { createReadStream, createWriteStream, existsSync } from 'node:fs';
import { mkdir, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { z } from 'zod/v3';
import type { CrowiPlugin, StorageDriver } from '@crowi/plugin-api';

const LocalStorageConfigSchema = z
  .object({
    /** Relative paths resolve against the directory containing `crowi.config.json`. */
    rootDir: z.string().default('data/uploads'),
  })
  .strict();

type LocalStorageConfig = z.infer<typeof LocalStorageConfigSchema>;

const plugin: CrowiPlugin = {
  name: '@crowi/plugin-storage-local',
  version: '0.1.0-dev',
  configSchema: LocalStorageConfigSchema,
  adminPlacement: {
    label: 'Local storage',
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

export function createLocalDriver(config: LocalStorageConfig): StorageDriver {
  const root = path.isAbsolute(config.rootDir) ? config.rootDir : path.resolve(process.cwd(), config.rootDir);

  // Reject `..` / absolute paths that would escape rootDir
  // (e.g. key = '../../etc/passwd').
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
        // Object.assign (not a cast) so tsup emits valid JS for ts-node;
        // the cast form leaves a raw `err.code = …` that ts-node rejects.
        throw Object.assign(new Error(`Storage key '${key}' does not exist`), { code: 'ENOENT' });
      }
      return createReadStream(target);
    },

    async delete(key) {
      const target = resolveSafe(key);
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
