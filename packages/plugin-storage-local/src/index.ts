import { randomBytes } from 'node:crypto';
import { type Dirent, createReadStream, createWriteStream, existsSync } from 'node:fs';
import { mkdir, readdir, rename, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { z } from 'zod/v3';
import { CONFIG_VERIFICATION_KEY_PREFIX } from '@crowi/plugin-api';
import type { CrowiPlugin, PluginConfigVerificationResult, StorageDriver, VerificationFailureReason } from '@crowi/plugin-api';

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

  // feature-plugin-config-live-verification — snapshot-only, non-blocking.
  // Builds its own throwaway driver from the snapshot (never the live
  // driver behind `registry`/`ctx.state()`) and does a real
  // `put -> get -> delete` round trip under the reserved verification key
  // namespace, so a misconfigured `rootDir` (missing parent, wrong
  // permissions) surfaces after save instead of silently at the next real
  // upload.
  verifyConfig: async (snapshot) => {
    const driver = createLocalDriver(snapshot.config<LocalStorageConfig>());
    return probeStorageDriver(driver, classifyLocalStorageError);
  },
};

export default plugin;

/**
 * The put -> [independent-budget cleanup] -> get -> compare round trip
 * shared by every storage `verifyConfig` hook that already has a
 * `StorageDriver` to probe with. Generic over the public `StorageDriver`
 * contract (feature-plugin-config-live-verification §4) — takes no option
 * beyond what `put`/`get`/`delete` already accept, and never touches
 * anything outside the reserved `CONFIG_VERIFICATION_KEY_PREFIX` namespace.
 *
 * Exported (not just used internally) so it — and the independent-cleanup
 * behaviour in particular — can be tested directly against a driver double
 * without needing a real slow/hanging filesystem or network call: see
 * `storage-local.test.ts`. `cleanupTimeoutMs` overrides the cleanup budget
 * for exactly that purpose — production callers never pass it.
 */
export async function probeStorageDriver(
  driver: Pick<StorageDriver, 'put' | 'get' | 'delete'>,
  classify: (err: unknown) => VerificationFailureReason,
  cleanupTimeoutMs: number = VERIFICATION_CLEANUP_TIMEOUT_MS,
): Promise<PluginConfigVerificationResult> {
  const key = `${CONFIG_VERIFICATION_KEY_PREFIX}${randomBytes(16).toString('hex')}`;
  const payload = randomBytes(32);

  let putKey: string;
  try {
    ({ key: putKey } = await driver.put(key, payload, { contentType: 'application/octet-stream' }));
  } catch (err) {
    // Nothing was written — no probe object exists yet, so there is
    // nothing to clean up.
    return { status: 'failed', reason: classify(err) };
  }

  // The probe object now exists on disk — schedule its cleanup THIS
  // instant, racing "the read below settles" against the cleanup's own
  // budget, rather than sequencing cleanup strictly after the read
  // finishes. A read that settles quickly (the overwhelming common case)
  // still wins that race, so cleanup fires right after it as before; but a
  // read that never settles at all (a truly stuck stream) no longer holds
  // cleanup hostage forever — it fires once the budget elapses regardless
  // (AC-11). `read` is shared (not re-invoked) by the verdict computation
  // below.
  const read = driver.get(key).then(readAllBuffer);
  scheduleVerificationCleanup(driver, key, read, cleanupTimeoutMs);

  try {
    const bytes = await read;
    // A driver reporting success while silently storing under a different
    // key than requested, or returning corrupted bytes, is neither one of
    // the classified driver exceptions — there's no error to classify, so
    // 'unknown' is the honest reason rather than guessing a specific one.
    return putKey === key && bytes.equals(payload) ? { status: 'ok' } : { status: 'failed', reason: 'unknown' };
  } catch (err) {
    return { status: 'failed', reason: classify(err) };
  }
}

/** Independent budget for the fire-and-forget cleanup delete (feature-plugin-config-live-verification §3) — deliberately separate from the caller-side hook timeout. */
const VERIFICATION_CLEANUP_TIMEOUT_MS = 5_000;

/**
 * Fire a cleanup `delete(key)` off, decoupled from both the caller and from
 * `gate` (the in-flight read) ever settling. Triggered by whichever comes
 * first — `gate` settling (success or failure, read normally already done
 * by then) or `timeoutMs` elapsing — then calls `driver.delete(key)` and
 * lets it run to completion in the background; a failure is logged only
 * and never surfaces (same no-cancellation policy as the hook-level race —
 * see `PluginConfigVerificationOptions`'s doc). Never awaited by the
 * caller, never thrown out of.
 *
 * Deliberately NOT `Promise.race([gateSettled, budgetElapsed])`: racing two
 * promises adds a handful of extra microtask hops before the winner's
 * continuation runs, which — for the common case where `gate` settles well
 * under the budget — could still leave `driver.delete()` uncalled by the
 * time a caller that `await`s `gate` itself (one hop, not several) observes
 * completion. Attaching `trigger` directly to `gate` keeps the two on equal
 * footing: it fires in the very same microtask turn `gate`'s settlement is
 * observed.
 */
function scheduleVerificationCleanup(driver: Pick<StorageDriver, 'delete'>, key: string, gate: Promise<unknown>, timeoutMs: number): void {
  let triggered = false;
  let timer: ReturnType<typeof setTimeout>;
  const trigger = (): void => {
    if (triggered) return;
    triggered = true;
    clearTimeout(timer);
    // No error detail logged — a filesystem error can embed the resolved
    // absolute path (§3's no-raw-error-data contract).
    driver.delete(key).catch(() => {
      console.warn('[crowi:plugin:@crowi/plugin-storage-local] verification cleanup delete failed.');
    });
  };
  timer = setTimeout(trigger, timeoutMs);
  timer.unref?.();
  void gate.then(trigger, trigger);
}

async function readAllBuffer(stream: NodeJS.ReadableStream): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks);
}

/**
 * Classify a local-driver `put`/`get` failure into the fixed reason set
 * (feature-plugin-config-live-verification §3's table). Anything not
 * explicitly listed there falls into `'unknown'`.
 */
export function classifyLocalStorageError(err: unknown): VerificationFailureReason {
  const code = (err as NodeJS.ErrnoException | undefined)?.code;
  if (code === 'ENOENT') return 'resource-missing';
  if (code === 'EACCES' || code === 'EPERM' || code === 'EROFS') return 'write-denied';
  return 'unknown';
}

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
