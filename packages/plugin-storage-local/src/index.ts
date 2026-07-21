import { randomBytes } from 'node:crypto';
import { type Dirent, createReadStream, createWriteStream, existsSync } from 'node:fs';
import { mkdir, readdir, rename, rm, stat } from 'node:fs/promises';
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

/**
 * One object found under the `attachment/<pageId>/derivatives/<attachmentId>/`
 * namespace (feature-image-derivative-optimization §7/§11) — the shape
 * `--gc`'s local enumeration needs: the key to diff against the
 * Mongo-side referenced-key set, its byte size for the candidate-bytes
 * counter, and its `mtimeMs` for the grace-period filter.
 */
export interface LocalDerivativeObject {
  key: string;
  size: number;
  mtimeMs: number;
}

/**
 * A local driver that additionally exposes {@link LocalStorageDriver.listDerivativeObjects}.
 * `createLocalDriver` always returns one of these; callers that only hold a
 * generic `StorageDriver` (e.g. resolved via `getStorageDriverByName`) must
 * duck-type-check for the method before calling it — this is a driver-specific,
 * opt-in extension, NOT an addition to the core `StorageDriver` interface
 * (`@crowi/plugin-api`'s `put`/`get`/`delete`/`signedUrl?` stays untouched; see
 * `packages/plugin-api/src/registries/storage.ts`).
 */
export interface LocalStorageDriver extends StorageDriver {
  /**
   * Enumerate every object under the `attachment/*\/derivatives/*\/*`
   * namespace on this driver's `rootDir` — used exclusively by
   * `crowi-admin rebuild attachment-display-derivatives --gc` (local-only,
   * v1). Mirrors `statKey`'s "debug/ops export alongside the driver, not a
   * core interface method" shape. A missing `attachment/` (or per-page
   * `derivatives/`) directory is treated as "nothing to enumerate yet", not
   * an error.
   */
  listDerivativeObjects(): Promise<LocalDerivativeObject[]>;
}

/** Path segments shared with `Attachment.createAttachmentFilePath` / `buildDisplayDerivativeKey` (`packages/api/src/util/image-display-derivative.ts`) — duplicated here (not imported) so this leaf storage plugin stays independent of `@crowi/api`. */
const ATTACHMENT_KEY_PREFIX = 'attachment';
const DERIVATIVES_KEY_SEGMENT = 'derivatives';

export function createLocalDriver(config: LocalStorageConfig): LocalStorageDriver {
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

      // feature-image-derivative-optimization §7a — write to a
      // process-unique temp file, then atomically rename it into place
      // (POSIX same-filesystem rename is atomic). A reader's `get()`
      // therefore always observes either the previous complete object or
      // the new complete object, never a torn/partial write — required
      // once re-writing the SAME key (display-derivative regeneration) is
      // a normal occurrence rather than a rare overwrite. The suffix uses
      // `crypto.randomBytes` (not e.g. a fixed `<key>.tmp`) so two
      // processes racing to `put()` the same key never share a temp path
      // and interleave into a single corrupt temp file that both then
      // rename over the target.
      const tmpTarget = `${target}.${randomBytes(12).toString('hex')}.tmp`;
      let renamed = false;
      try {
        await pipeline(source, createWriteStream(tmpTarget));
        await rename(tmpTarget, target);
        renamed = true;
        return { key };
      } finally {
        if (!renamed) {
          await rm(tmpTarget, { force: true });
        }
      }
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

    async listDerivativeObjects(): Promise<LocalDerivativeObject[]> {
      const results: LocalDerivativeObject[] = [];
      const attachmentRoot = path.join(root, ATTACHMENT_KEY_PREFIX);

      const pageDirs = await readdirSafe(attachmentRoot);
      for (const pageDir of pageDirs) {
        if (!pageDir.isDirectory()) continue;
        const derivativesRoot = path.join(attachmentRoot, pageDir.name, DERIVATIVES_KEY_SEGMENT);
        const attachmentDirs = await readdirSafe(derivativesRoot);
        for (const attachmentDir of attachmentDirs) {
          if (!attachmentDir.isDirectory()) continue;
          const objectDir = path.join(derivativesRoot, attachmentDir.name);
          const files = await readdirSafe(objectDir);
          for (const file of files) {
            if (!file.isFile()) continue;
            const full = path.join(objectDir, file.name);
            const s = await stat(full);
            results.push({
              key: [ATTACHMENT_KEY_PREFIX, pageDir.name, DERIVATIVES_KEY_SEGMENT, attachmentDir.name, file.name].join('/'),
              size: s.size,
              mtimeMs: s.mtimeMs,
            });
          }
        }
      }
      return results;
    },
  };
}

/** `readdir` that treats a missing directory as "empty" instead of throwing — every level of the `attachment/*\/derivatives/*\/*` walk is optional (a fresh install has no `attachment/` dir at all yet). */
async function readdirSafe(dir: string): Promise<Dirent[]> {
  try {
    return await readdir(dir, { withFileTypes: true });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }
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
