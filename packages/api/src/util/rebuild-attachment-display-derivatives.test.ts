import { type ChildProcessByStdio, spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { Readable } from 'node:stream';
import { DeleteObjectCommand, GetObjectCommand, PutObjectCommand, type S3Client } from '@aws-sdk/client-s3';
import type { StateCell, StorageDriver } from '@crowi/plugin-api';
import { createS3Driver } from '@crowi/plugin-storage-aws-s3';
import { createLocalDriver } from '@crowi/plugin-storage-local';
import { Types } from 'mongoose';
import sharp from 'sharp';

import { RebuildRunner } from 'src/migration/rebuild-runner';
import { attachmentDisplayDerivativesRebuild } from 'src/migration/rebuilds';
import type { AttachmentDocument } from 'src/models/attachment';
import { crowi, MONGO_URI } from 'src/test/setup';
import * as imageDisplayDerivative from 'src/util/image-display-derivative';
import {
  type AttachmentDisplayDerivative,
  buildDisplayDerivativeKey,
  DISPLAY_DERIVATIVE_RECIPE_VERSION,
  displayDerivativeKeyCandidates,
} from 'src/util/image-display-derivative';

import {
  DEFAULT_GC_GRACE_HOURS,
  forEachBounded,
  PER_ITEM_STAGE_ESTIMATE_BYTES,
  runAttachmentDisplayDerivativesRebuild,
} from './rebuild-attachment-display-derivatives';

/**
 * feature-image-derivative-optimization Phase 3 §11 — unit + local/S3
 * integration coverage for `crowi-admin rebuild attachment-display-derivatives`.
 *
 * Strategy mirrors `image-display-derivative.test.ts` (Phase 1): a fake S3
 * driver wraps the REAL `@aws-sdk/client-s3` Command classes against an
 * in-memory bucket (so "local・S3両ドライバに対する結合テスト" exercises the
 * actual `createS3Driver` code path), and `withDriver` temporarily swaps the
 * process-wide active storage driver for the duration of one test.
 *
 * `runAttachmentDisplayDerivativesRebuild` is called both directly (low-level
 * unit coverage, with a hand-built `runner: Pick<RebuildRunner,
 * 'concurrency'|'aborted'>` so SIGINT-style abortion is deterministic and
 * doesn't require sending a real OS signal) and through the real
 * `RebuildRunner` + `attachmentDisplayDerivativesRebuild` dispatcher (a
 * couple of end-to-end wiring checks).
 */

// ---------------------------------------------------------------------------
// Fixture builders
// ---------------------------------------------------------------------------

async function rasterJpeg(width: number, height: number): Promise<Buffer> {
  return sharp({ create: { width, height, channels: 3, background: { r: 90, g: 130, b: 170 } } })
    .jpeg()
    .toBuffer();
}

/** Large enough to always resize (spec: >1728px wide). */
const LARGE_JPEG_WIDTH = 2000;
const LARGE_JPEG_HEIGHT = 1000;
/** Small enough to always classify passthrough/within-target-width. */
const SMALL_JPEG_WIDTH = 100;
const SMALL_JPEG_HEIGHT = 100;

// ---------------------------------------------------------------------------
// Fake S3 driver — same approach as image-display-derivative.test.ts.
// ---------------------------------------------------------------------------

async function toBuffer(input: Buffer | Readable): Promise<Buffer> {
  if (Buffer.isBuffer(input)) return input;
  const chunks: Buffer[] = [];
  for await (const chunk of input) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks);
}

/** Trickles `data` out `chunkSize` bytes at a time with `delayMs` between pushes — used to slow down staging enough to reliably sample the tmp dir's on-disk footprint mid-transfer (AC2's "concurrently-staged bytes stay bounded" test). */
function throttledReadable(data: Buffer, chunkSize: number, delayMs: number): Readable {
  let offset = 0;
  return new Readable({
    read() {
      if (offset >= data.length) {
        this.push(null);
        return;
      }
      const chunk = data.subarray(offset, Math.min(offset + chunkSize, data.length));
      offset += chunk.length;
      setTimeout(() => this.push(chunk), delayMs);
    },
  });
}

function makeFakeS3Driver(): StorageDriver {
  const bucket = new Map<string, Buffer>();

  const fakeClient = {
    async send(command: unknown): Promise<unknown> {
      if (command instanceof PutObjectCommand) {
        const { Key, Body } = command.input;
        bucket.set(Key as string, await toBuffer(Body as Buffer | Readable));
        return {};
      }
      if (command instanceof GetObjectCommand) {
        const { Key } = command.input;
        const data = bucket.get(Key as string);
        if (!data) {
          throw Object.assign(new Error('The specified key does not exist.'), {
            name: 'NoSuchKey',
            $metadata: { httpStatusCode: 404 },
          });
        }
        return { Body: Readable.from(data) };
      }
      if (command instanceof DeleteObjectCommand) {
        bucket.delete(command.input.Key as string);
        return {};
      }
      throw new Error(`makeFakeS3Driver: unexpected command ${String((command as { constructor: { name: string } }).constructor.name)}`);
    },
    destroy: () => {},
  };

  const cell: StateCell<{ client: S3Client; bucket: string }> = {
    get: () => ({ client: fakeClient as unknown as S3Client, bucket: 'fake-bucket' }),
    withValue: async (fn) => fn({ client: fakeClient as unknown as S3Client, bucket: 'fake-bucket' }),
    set: () => {
      throw new Error('makeFakeS3Driver: set() is not supported — this fake never reconfigures');
    },
  };

  return createS3Driver(cell);
}

type DriverKind = 'local' | 's3';

/**
 * Temporarily makes `kind`'s driver the process-wide active storage driver
 * for the duration of `fn`, then restores whatever was active before. For
 * `'local'`, also hands back the driver's filesystem root (needed by the
 * `--gc` grace-period tests to backdate an object's mtime directly).
 */
async function withDriver<T>(kind: DriverKind, fn: (driver: StorageDriver, localRoot: string | null) => Promise<T>): Promise<T> {
  const registries = crowi.getPlugins();
  const original = registries.active.storage;
  let localRoot: string | null = null;
  const driver =
    kind === 'local'
      ? createLocalDriver({ rootDir: (localRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'crowi-rebuild-derivatives-'))) })
      : makeFakeS3Driver();
  registries.active.storage = driver;
  try {
    return await fn(driver, localRoot);
  } finally {
    registries.active.storage = original;
    if (localRoot) await fs.rm(localRoot, { recursive: true, force: true });
  }
}

async function expectMissingObject(kind: DriverKind, promise: Promise<unknown>): Promise<void> {
  if (kind === 'local') {
    await expect(promise).rejects.toMatchObject({ code: 'ENOENT' });
  } else {
    await expect(promise).rejects.toMatchObject({ name: 'NoSuchKey' });
  }
}

interface SeedOptions {
  originalBytes?: Buffer;
  fileFormat?: string;
  ext?: 'jpg' | 'png' | 'webp';
  display?: AttachmentDisplayDerivative;
  createdAt?: Date;
  /** When false, skip writing the original bytes into storage (simulates a missing original). */
  putOriginal?: boolean;
}

/** Create an Attachment row (with a real original object in `driver`, by default a large JPEG) directly via the model — no HTTP round trip needed since `page` is just an opaque ObjectId. */
async function seedAttachment(
  driver: StorageDriver,
  opts: SeedOptions = {},
): Promise<{ attachment: AttachmentDocument; pageId: Types.ObjectId; originalKey: string }> {
  const pageId = new Types.ObjectId();
  const attachmentId = new Types.ObjectId();
  const ext = opts.ext ?? 'jpg';
  const bytes = opts.originalBytes ?? (await rasterJpeg(LARGE_JPEG_WIDTH, LARGE_JPEG_HEIGHT));
  const originalKey = `attachment/${pageId}/original-${attachmentId}.${ext}`;
  if (opts.putOriginal !== false) {
    await driver.put(originalKey, bytes, { contentType: opts.fileFormat ?? 'image/jpeg' });
  }

  const Attachment = crowi.model('Attachment');
  const attachment = (await Attachment.create({
    _id: attachmentId,
    page: pageId,
    filePath: originalKey,
    fileName: `${attachmentId}.${ext}`,
    originalName: `original.${ext}`,
    fileFormat: opts.fileFormat ?? 'image/jpeg',
    fileSize: bytes.length,
    createdAt: opts.createdAt,
    derivatives: opts.display ? { display: opts.display } : undefined,
  })) as AttachmentDocument;

  return { attachment, pageId, originalKey };
}

function resizedDerivative(
  pageId: Types.ObjectId,
  attachmentId: Types.ObjectId,
  overrides: Partial<AttachmentDisplayDerivative> = {},
): AttachmentDisplayDerivative {
  return {
    recipeVersion: DISPLAY_DERIVATIVE_RECIPE_VERSION,
    mode: 'resized',
    filePath: buildDisplayDerivativeKey(pageId, attachmentId, 'jpg'),
    format: 'image/jpeg',
    width: 1728,
    height: 864,
    size: 12345,
    generatedAt: new Date(),
    ...overrides,
  };
}

/** A controllable fake `Pick<RebuildRunner, 'concurrency'|'aborted'>` — avoids sending real OS signals to simulate SIGINT. */
function makeFakeRunner(concurrency: number) {
  let abortedFlag = false;
  return {
    concurrency,
    get aborted(): boolean {
      return abortedFlag;
    },
    setAborted(v: boolean) {
      abortedFlag = v;
    },
  };
}

function makeCtx(dryRun: boolean) {
  // `RebuildRunner.context` builds a real `MigrationContext` (db/crowi/logger/
  // progress/dryRun) — reused here without going through `.run()` so tests can
  // pair it with a hand-built fake `runner` for deterministic abort control.
  return new RebuildRunner(crowi, { dryRun }).context;
}

const AMPLE_FREE_BYTES = { checkFreeBytes: async () => Number.MAX_SAFE_INTEGER };

async function readTmpDirEntries(): Promise<string[]> {
  try {
    return await fs.readdir(crowi.tmpDir);
  } catch {
    return [];
  }
}

// `crowi.tmpDir` normally resolves to a SINGLE FIXED directory under
// `packages/api/` (`ROOT_DIR` in `crowi-environment.js` is not per-test-file
// or per-worker-unique) — every concurrently-running test file/worker that
// stages a rebuild tmp file shares that exact same physical directory. Since
// several tests in this file assert "no leftover staged tmp file", we swap
// `crowi.tmpDir` to a freshly-`mkdtemp`'d directory for the duration of
// EVERY test here so tmp-cleanliness assertions are only ever influenced by
// THIS test's own run, never by an unrelated concurrent test/worker (e.g.
// `migration/rebuild-runner.test.ts`'s own `rebuildAttachmentDisplayDerivatives`
// coverage, which exercises the exact same staging code path).
let originalTmpDir: string;
let isolatedTmpDir: string;

beforeEach(async () => {
  originalTmpDir = crowi.tmpDir;
  isolatedTmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'crowi-rebuild-derivatives-tmpdir-'));
  crowi.tmpDir = isolatedTmpDir;
});

afterEach(async () => {
  crowi.tmpDir = originalTmpDir;
  await fs.rm(isolatedTmpDir, { recursive: true, force: true });
  await crowi.model('Attachment').deleteMany({});
});

// ---------------------------------------------------------------------------
// forEachBounded — cursor discipline + bounded concurrency + abort
// ---------------------------------------------------------------------------

describe('forEachBounded', () => {
  async function* fromArray<T>(items: T[]): AsyncGenerator<T> {
    for (const item of items) yield item;
  }

  it('is the SOLE caller of the source iterator (a `for await` loop pulls sequentially — never two `next()` calls in flight at once)', async () => {
    let inFlightNextCalls = 0;
    let maxInFlightNextCalls = 0;
    const items = [1, 2, 3, 4, 5];
    const source: AsyncIterable<number> = {
      [Symbol.asyncIterator]() {
        let i = 0;
        return {
          async next() {
            inFlightNextCalls += 1;
            maxInFlightNextCalls = Math.max(maxInFlightNextCalls, inFlightNextCalls);
            await new Promise((r) => setTimeout(r, 1));
            inFlightNextCalls -= 1;
            if (i >= items.length) return { done: true, value: undefined };
            return { done: false, value: items[i++] };
          },
        };
      },
    };

    const seen: number[] = [];
    const { interrupted } = await forEachBounded(
      source,
      3,
      () => false,
      async (n) => {
        await new Promise((r) => setTimeout(r, 5));
        seen.push(n);
      },
    );

    expect(interrupted).toBe(false);
    expect(seen.sort()).toEqual(items);
    // Never more than one `next()` outstanding at a time — the bounded fan-out
    // only applies to WORKER processing, not to cursor pulls.
    expect(maxInFlightNextCalls).toBe(1);
  });

  it('bounds in-flight worker processing to `concurrency` even though items are pulled one at a time', async () => {
    let current = 0;
    let max = 0;
    const items = [1, 2, 3, 4, 5, 6];
    await forEachBounded(
      fromArray(items),
      3,
      () => false,
      async () => {
        current += 1;
        max = Math.max(max, current);
        await new Promise((r) => setTimeout(r, 20));
        current -= 1;
      },
    );
    expect(max).toBe(3);
  });

  it('stops pulling new items once aborted, but still awaits whatever is already in flight', async () => {
    const items = [1, 2, 3, 4, 5];
    const seen: number[] = [];
    let aborted = false;
    const { interrupted } = await forEachBounded(
      fromArray(items),
      1,
      () => aborted,
      async (n) => {
        seen.push(n);
        if (n === 1) aborted = true;
      },
    );
    expect(interrupted).toBe(true);
    // Concurrency 1 means item 1 is pulled+processed, THEN the loop checks
    // `aborted()` before pulling item 2 — so nothing past item 1 is touched.
    expect(seen).toEqual([1]);
  });

  it("checks the abort flag BEFORE pulling the next item, not merely after — a `for await...of` loop's implicit pre-fetch would otherwise pull-and-discard one extra item past the abort point", async () => {
    const items = [1, 2, 3, 4, 5];
    let nextCalls = 0;
    const source: AsyncIterable<number> = {
      [Symbol.asyncIterator]() {
        let i = 0;
        return {
          async next() {
            nextCalls += 1;
            if (i >= items.length) return { done: true, value: undefined };
            return { done: false, value: items[i++] };
          },
        };
      },
    };

    let aborted = false;
    const { interrupted } = await forEachBounded(
      source,
      1,
      () => aborted,
      async (n) => {
        if (n === 1) aborted = true;
      },
    );

    expect(interrupted).toBe(true);
    // Exactly ONE `next()` call — item 1 is pulled, processed (which sets
    // `aborted`), and the loop must observe `aborted()` BEFORE calling
    // `next()` again for item 2. A `for await...of` loop's implicit
    // "evaluate `next()` to check the loop condition, THEN run the body"
    // ordering would call `next()` a SECOND time (pulling — and, via
    // `break`, silently discarding — item 2) before the body ever gets to
    // consult `aborted()`. Counting `next()` calls directly (rather than
    // only checking which items the WORKER touched, as the test above
    // does) is what actually distinguishes "never asked the cursor for
    // item 2 at all" from "asked for it but threw the result away" — the
    // former is the real guarantee this function exists to provide, since a
    // Mongo cursor `next()` is a genuine network round trip, not a free
    // operation to pull and discard.
    expect(nextCalls).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// generate mode
// ---------------------------------------------------------------------------

describe('runAttachmentDisplayDerivativesRebuild — generate mode', () => {
  it('dry-run reports counts without writing to Mongo or storage', async () => {
    await withDriver('local', async (driver) => {
      const { attachment, originalKey } = await seedAttachment(driver, {});
      const runner = makeFakeRunner(2);

      const stats = await runAttachmentDisplayDerivativesRebuild(crowi, {}, makeCtx(true), runner, AMPLE_FREE_BYTES);

      expect(stats).toMatchObject({ mode: 'generate', scanned: 1, wouldProcess: 1, generated: 0, passthrough: 0, unsupported: 0, failed: 0 });

      const reloaded = await crowi.model('Attachment').findById(attachment._id);
      expect(reloaded?.derivatives).toBeUndefined();
      // Only the original object exists — dry-run never `put`s a derivative.
      await expect(driver.get(originalKey)).resolves.toBeDefined();
    });
  });

  it('classifies never-evaluated large/small/undecodable attachments as resized/passthrough/failed in a single run', async () => {
    await withDriver('local', async (driver) => {
      const large = await seedAttachment(driver, { originalBytes: await rasterJpeg(LARGE_JPEG_WIDTH, LARGE_JPEG_HEIGHT) });
      const small = await seedAttachment(driver, { originalBytes: await rasterJpeg(SMALL_JPEG_WIDTH, SMALL_JPEG_HEIGHT) });
      const garbage = await seedAttachment(driver, { originalBytes: Buffer.from('not a real jpeg'), fileFormat: 'image/jpeg' });
      const runner = makeFakeRunner(2);

      // `crowi.tmpDir` is process-shared (not per-test-unique) across
      // concurrently-running jest workers/files — snapshot before/after
      // rather than asserting global absence of the prefix (see the
      // "stops accepting new items once aborted" test's comment below).
      const before = new Set(await readTmpDirEntries());
      const stats = await runAttachmentDisplayDerivativesRebuild(crowi, {}, makeCtx(false), runner, AMPLE_FREE_BYTES);
      const after = await readTmpDirEntries();

      expect(stats).toMatchObject({ scanned: 3, generated: 1, passthrough: 1, failed: 1, unsupported: 0 });
      if (stats.mode !== 'generate') throw new Error('unreachable');
      expect(stats.failures).toEqual([{ attachmentId: String(garbage.attachment._id), reason: 'decode-error' }]);

      const largeReloaded = await crowi.model('Attachment').findById(large.attachment._id);
      expect(largeReloaded?.derivatives?.display?.mode).toBe('resized');
      const smallReloaded = await crowi.model('Attachment').findById(small.attachment._id);
      expect(smallReloaded?.derivatives?.display).toMatchObject({ mode: 'passthrough', reason: 'within-target-width' });
      const garbageReloaded = await crowi.model('Attachment').findById(garbage.attachment._id);
      expect(garbageReloaded?.derivatives?.display).toMatchObject({ mode: 'failed', reason: 'decode-error' });

      // No leftover staged tmp files after a full run (success + failure paths both clean up).
      expect(after.filter((f) => !before.has(f))).toEqual([]);
    });
  });

  it('normal rerun skips completed current-recipe records (resized/passthrough/unsupported) but retries failed/unset', async () => {
    await withDriver('local', async (driver) => {
      const resized = await seedAttachment(driver, { display: resizedDerivative(new Types.ObjectId(), new Types.ObjectId()) });
      const passthrough = await seedAttachment(driver, {
        display: { recipeVersion: DISPLAY_DERIVATIVE_RECIPE_VERSION, mode: 'passthrough', reason: 'within-target-width', generatedAt: new Date() },
      });
      const unsupported = await seedAttachment(driver, {
        ext: 'gif' as never,
        fileFormat: 'image/gif',
        display: { recipeVersion: DISPLAY_DERIVATIVE_RECIPE_VERSION, mode: 'unsupported', reason: 'gif', generatedAt: new Date() },
      });
      const failed = await seedAttachment(driver, {
        originalBytes: await rasterJpeg(LARGE_JPEG_WIDTH, LARGE_JPEG_HEIGHT),
        display: { recipeVersion: DISPLAY_DERIVATIVE_RECIPE_VERSION, mode: 'failed', reason: 'decode-error', generatedAt: new Date() },
      });
      const neverEvaluated = await seedAttachment(driver, { originalBytes: await rasterJpeg(SMALL_JPEG_WIDTH, SMALL_JPEG_HEIGHT) });
      void resized;
      void passthrough;
      void unsupported;

      const runner = makeFakeRunner(2);
      const stats = await runAttachmentDisplayDerivativesRebuild(crowi, {}, makeCtx(false), runner, AMPLE_FREE_BYTES);

      expect(stats).toMatchObject({ scanned: 5, skippedCurrent: 3 });
      if (stats.mode !== 'generate') throw new Error('unreachable');
      // `failed` and never-evaluated rows are retried on a normal rerun.
      expect(stats.generated).toBe(1); // the large-JPEG failed-row regenerates to `resized`
      expect(stats.passthrough).toBe(1); // the small never-evaluated row regenerates to `passthrough`

      const failedReloaded = await crowi.model('Attachment').findById(failed.attachment._id);
      expect(failedReloaded?.derivatives?.display?.mode).toBe('resized');
      const neverEvaluatedReloaded = await crowi.model('Attachment').findById(neverEvaluated.attachment._id);
      expect(neverEvaluatedReloaded?.derivatives?.display?.mode).toBe('passthrough');
    });
  });

  it('a `resized` record whose object is lost from storage stays skipped on a normal rerun (needs --force or --repair-missing)', async () => {
    await withDriver('local', async (driver) => {
      const pageId = new Types.ObjectId();
      const attachmentId = new Types.ObjectId();
      const { attachment } = await seedAttachment(driver, {
        display: resizedDerivative(pageId, attachmentId, { filePath: buildDisplayDerivativeKey(pageId, attachmentId, 'jpg') }),
      });
      // The derivative object was never actually put (simulates a storage
      // migration that only copied originals — spec §11).
      const runner = makeFakeRunner(2);

      const normalStats = await runAttachmentDisplayDerivativesRebuild(crowi, {}, makeCtx(false), runner, AMPLE_FREE_BYTES);
      expect(normalStats).toMatchObject({ scanned: 1, skippedCurrent: 1, generated: 0 });

      const forceStats = await runAttachmentDisplayDerivativesRebuild(crowi, { force: true }, makeCtx(false), runner, AMPLE_FREE_BYTES);
      expect(forceStats).toMatchObject({ scanned: 1, skippedCurrent: 0, generated: 1 });

      const reloaded = await crowi.model('Attachment').findById(attachment._id);
      expect(reloaded?.derivatives?.display?.mode).toBe('resized');
      await expect(driver.get(reloaded?.derivatives?.display?.filePath as string)).resolves.toBeDefined();
    });
  });

  it('`onlyMissing` narrows the cursor to attachments with no `derivatives.display` at all', async () => {
    await withDriver('local', async (driver) => {
      await seedAttachment(driver, { display: resizedDerivative(new Types.ObjectId(), new Types.ObjectId()) });
      await seedAttachment(driver, { originalBytes: await rasterJpeg(SMALL_JPEG_WIDTH, SMALL_JPEG_HEIGHT) });
      const runner = makeFakeRunner(2);

      const stats = await runAttachmentDisplayDerivativesRebuild(crowi, { onlyMissing: true }, makeCtx(false), runner, AMPLE_FREE_BYTES);
      expect(stats).toMatchObject({ scanned: 1, passthrough: 1 });
    });
  });

  it('`onlyStaleRecipe` excludes a current-recipe record', async () => {
    await withDriver('local', async (driver) => {
      await seedAttachment(driver, { display: resizedDerivative(new Types.ObjectId(), new Types.ObjectId()) });
      const runner = makeFakeRunner(2);

      const stats = await runAttachmentDisplayDerivativesRebuild(crowi, { onlyStaleRecipe: true }, makeCtx(false), runner, AMPLE_FREE_BYTES);
      expect(stats).toMatchObject({ scanned: 0 });
    });
  });

  it('`pageId` filter narrows the cursor to a single page', async () => {
    await withDriver('local', async (driver) => {
      const a = await seedAttachment(driver, { originalBytes: await rasterJpeg(SMALL_JPEG_WIDTH, SMALL_JPEG_HEIGHT) });
      await seedAttachment(driver, { originalBytes: await rasterJpeg(SMALL_JPEG_WIDTH, SMALL_JPEG_HEIGHT) });
      const runner = makeFakeRunner(2);

      const stats = await runAttachmentDisplayDerivativesRebuild(crowi, { pageId: a.pageId.toString() }, makeCtx(false), runner, AMPLE_FREE_BYTES);
      expect(stats).toMatchObject({ scanned: 1 });
    });
  });

  it('`since`/`until` filter narrows the cursor by `createdAt`', async () => {
    await withDriver('local', async (driver) => {
      await seedAttachment(driver, { originalBytes: await rasterJpeg(SMALL_JPEG_WIDTH, SMALL_JPEG_HEIGHT), createdAt: new Date('2020-01-01T00:00:00Z') });
      await seedAttachment(driver, { originalBytes: await rasterJpeg(SMALL_JPEG_WIDTH, SMALL_JPEG_HEIGHT), createdAt: new Date('2024-01-01T00:00:00Z') });
      const runner = makeFakeRunner(2);

      const stats = await runAttachmentDisplayDerivativesRebuild(crowi, { since: new Date('2023-01-01T00:00:00Z') }, makeCtx(false), runner, AMPLE_FREE_BYTES);
      expect(stats).toMatchObject({ scanned: 1 });
    });
  });

  it('insufficient free space marks the item failed (reason insufficient-disk-space) without touching Mongo or storage, so it self-heals on the next run', async () => {
    await withDriver('local', async (driver) => {
      const { attachment } = await seedAttachment(driver, {});
      const runner = makeFakeRunner(2);
      const required = Math.max(1, runner.concurrency) * PER_ITEM_STAGE_ESTIMATE_BYTES;

      const stats = await runAttachmentDisplayDerivativesRebuild(crowi, {}, makeCtx(false), runner, { checkFreeBytes: async () => required - 1 });
      expect(stats).toMatchObject({ failed: 1 });
      if (stats.mode !== 'generate') throw new Error('unreachable');
      expect(stats.failures).toEqual([{ attachmentId: String(attachment._id), reason: 'insufficient-disk-space' }]);

      const reloaded = await crowi.model('Attachment').findById(attachment._id);
      expect(reloaded?.derivatives).toBeUndefined(); // never published — eligible for a plain retry, no --force needed
    });
  });

  it('exactly `concurrency * 100MB` free bytes is treated as sufficient (boundary)', async () => {
    await withDriver('local', async (driver) => {
      await seedAttachment(driver, {});
      const runner = makeFakeRunner(2);
      const required = Math.max(1, runner.concurrency) * PER_ITEM_STAGE_ESTIMATE_BYTES;

      const stats = await runAttachmentDisplayDerivativesRebuild(crowi, {}, makeCtx(false), runner, { checkFreeBytes: async () => required });
      expect(stats).toMatchObject({ failed: 0, generated: 1 });
    });
  });

  it('a disk-space CHECK failure itself (not "insufficient", the probe throwing) is recorded as a distinct failure reason', async () => {
    await withDriver('local', async (driver) => {
      await seedAttachment(driver, {});
      const runner = makeFakeRunner(2);
      const stats = await runAttachmentDisplayDerivativesRebuild(crowi, {}, makeCtx(false), runner, {
        checkFreeBytes: async () => {
          throw new Error('statfs boom');
        },
      });
      expect(stats).toMatchObject({ failed: 1 });
      if (stats.mode !== 'generate') throw new Error('unreachable');
      expect(stats.failures[0].reason).toBe('disk-space-check-failed');
    });
  });

  it('an original that is missing from storage is recorded as a failure without throwing the whole run', async () => {
    await withDriver('local', async (driver) => {
      const { attachment } = await seedAttachment(driver, { putOriginal: false });
      const runner = makeFakeRunner(2);
      const stats = await runAttachmentDisplayDerivativesRebuild(crowi, {}, makeCtx(false), runner, AMPLE_FREE_BYTES);
      expect(stats).toMatchObject({ failed: 1 });
      if (stats.mode !== 'generate') throw new Error('unreachable');
      expect(stats.failures).toEqual([{ attachmentId: String(attachment._id), reason: 'original-missing' }]);
    });
  });

  it('stages the original into `crowi.tmpDir` and cleans up its own staged file after processing (success and failure both)', async () => {
    await withDriver('local', async (driver) => {
      await seedAttachment(driver, { originalBytes: await rasterJpeg(LARGE_JPEG_WIDTH, LARGE_JPEG_HEIGHT) });
      await seedAttachment(driver, { originalBytes: Buffer.from('garbage'), fileFormat: 'image/jpeg' });
      const runner = makeFakeRunner(2);

      const before = await readTmpDirEntries();
      await runAttachmentDisplayDerivativesRebuild(crowi, {}, makeCtx(false), runner, AMPLE_FREE_BYTES);
      const after = await readTmpDirEntries();

      expect(after.filter((f) => f.startsWith('rebuild-display-derivative-'))).toEqual([]);
      expect(after.length).toBe(before.length);
    });
  });

  it('cleans up a PARTIALLY-staged tmp file even when the source stream errors mid-transfer, not only when a fully-staged file goes on to fail classification', async () => {
    await withDriver('local', async (driver) => {
      const { attachment, originalKey } = await seedAttachment(driver, { originalBytes: await rasterJpeg(LARGE_JPEG_WIDTH, LARGE_JPEG_HEIGHT) });
      const runner = makeFakeRunner(1);

      const realGet = driver.get.bind(driver);
      const getSpy = jest.spyOn(driver, 'get').mockImplementation(async (key: string) => {
        if (key !== originalKey) return realGet(key);
        // Push a few real bytes (so `createWriteStream` has actually
        // written something to `tmpPath`), THEN error the source stream —
        // simulates a connectivity blip partway through staging, which
        // `createWriteStream`'s open-on-construction semantics mean already
        // left a non-empty file on disk by the time `pipeline()` rejects.
        return new Readable({
          read() {
            this.push(Buffer.from('a few bytes before the connection drops'));
            setImmediate(() => this.destroy(new Error('simulated mid-stream read failure')));
          },
        });
      });

      const before = await readTmpDirEntries();
      let stats: Awaited<ReturnType<typeof runAttachmentDisplayDerivativesRebuild>>;
      try {
        stats = await runAttachmentDisplayDerivativesRebuild(crowi, {}, makeCtx(false), runner, AMPLE_FREE_BYTES);
      } finally {
        getSpy.mockRestore();
      }
      const after = await readTmpDirEntries();

      expect(stats).toMatchObject({ failed: 1 });
      if (stats.mode !== 'generate') throw new Error('unreachable');
      expect(stats.failures).toEqual([{ attachmentId: String(attachment._id), reason: 'staging-io-error' }]);

      // No leftover PARTIAL file — cleanup does not depend on the pipeline
      // having fully succeeded before it can run.
      expect(after.filter((f) => f.startsWith('rebuild-display-derivative-'))).toEqual([]);
      expect(after.length).toBe(before.length);

      const reloaded = await crowi.model('Attachment').findById(attachment._id);
      expect(reloaded?.derivatives).toBeUndefined(); // never published — eligible for a plain retry
    });
  });

  it('enforces the per-item staging byte limit while streaming: an original larger than the injected limit is rejected (reason `original-exceeds-stage-limit`) without ever writing a leftover tmp file', async () => {
    await withDriver('local', async (driver) => {
      const bytes = await rasterJpeg(LARGE_JPEG_WIDTH, LARGE_JPEG_HEIGHT);
      const { attachment } = await seedAttachment(driver, { originalBytes: bytes });
      const runner = makeFakeRunner(1);
      const tinyLimit = Math.floor(bytes.length / 2); // guaranteed to overflow mid-stream

      const before = await readTmpDirEntries();
      const stats = await runAttachmentDisplayDerivativesRebuild(crowi, {}, makeCtx(false), runner, {
        checkFreeBytes: async () => Number.MAX_SAFE_INTEGER,
        perItemStageLimitBytes: tinyLimit,
      });
      const after = await readTmpDirEntries();

      expect(stats).toMatchObject({ failed: 1 });
      if (stats.mode !== 'generate') throw new Error('unreachable');
      expect(stats.failures).toEqual([{ attachmentId: String(attachment._id), reason: 'original-exceeds-stage-limit' }]);

      expect(after.filter((f) => f.startsWith('rebuild-display-derivative-'))).toEqual([]);
      expect(after.length).toBe(before.length);

      const reloaded = await crowi.model('Attachment').findById(attachment._id);
      expect(reloaded?.derivatives).toBeUndefined(); // never published — eligible for a plain retry (no --force needed)
    });
  });

  it('bounds the ACTUAL concurrently-staged byte volume on disk to `concurrency × perItemStageLimitBytes` during a real concurrent run — not just the generator-invocation-count proxy the next test uses', async () => {
    await withDriver('local', async (driver) => {
      const CONCURRENCY = 2;
      const STAGE_LIMIT_BYTES = 200_000; // small injected limit — no need for real 100MB fixtures
      const ITEM_BYTES = 150_000; // comfortably under STAGE_LIMIT_BYTES once fully staged
      const ITEM_COUNT = 4;

      const originalKeys = new Set<string>();
      for (let i = 0; i < ITEM_COUNT; i += 1) {
        const { originalKey } = await seedAttachment(driver, { originalBytes: Buffer.alloc(ITEM_BYTES, i + 1) });
        originalKeys.add(originalKey);
      }

      const realGet = driver.get.bind(driver);
      const getSpy = jest.spyOn(driver, 'get').mockImplementation(async (key: string) => {
        if (!originalKeys.has(key)) return realGet(key);
        // Trickle each original out slowly enough (10 chunks x 5ms) that
        // staging takes ~50ms per item — long enough to reliably sample the
        // tmp dir's on-disk footprint mid-transfer below.
        const data = await toBuffer(await realGet(key));
        return throttledReadable(data, 15_000, 5);
      });

      let maxObservedBytes = 0;
      let maxObservedFiles = 0;
      const pollTimer = setInterval(() => {
        void (async () => {
          try {
            const entries = await fs.readdir(crowi.tmpDir);
            const staged = entries.filter((f) => f.startsWith('rebuild-display-derivative-'));
            let total = 0;
            for (const name of staged) {
              try {
                total += (await fs.stat(path.join(crowi.tmpDir, name))).size;
              } catch {
                // Removed between readdir and stat (cleanup finished) — ignore.
              }
            }
            maxObservedBytes = Math.max(maxObservedBytes, total);
            maxObservedFiles = Math.max(maxObservedFiles, staged.length);
          } catch {
            // tmpDir momentarily absent between mkdir calls — ignore.
          }
        })();
      }, 3);

      let stats: Awaited<ReturnType<typeof runAttachmentDisplayDerivativesRebuild>>;
      try {
        const runner = makeFakeRunner(CONCURRENCY);
        stats = await runAttachmentDisplayDerivativesRebuild(crowi, {}, makeCtx(false), runner, {
          checkFreeBytes: async () => Number.MAX_SAFE_INTEGER,
          perItemStageLimitBytes: STAGE_LIMIT_BYTES,
        });
      } finally {
        clearInterval(pollTimer);
        getSpy.mockRestore();
      }

      expect(stats).toMatchObject({ scanned: ITEM_COUNT });
      // Sanity: polling actually observed staging activity, and genuine
      // overlap between 2 concurrently-staged files (not a vacuously-true
      // assertion because polling missed everything or never caught 2 at
      // once).
      expect(maxObservedFiles).toBeGreaterThanOrEqual(2);
      // The AC's actual bound: total on-disk bytes across all concurrently
      // staged files never exceeded `concurrency × perItemStageLimitBytes`.
      expect(maxObservedFiles).toBeLessThanOrEqual(CONCURRENCY);
      expect(maxObservedBytes).toBeLessThanOrEqual(CONCURRENCY * STAGE_LIMIT_BYTES);
    });
  });

  it('bounds concurrent generator invocations to `--concurrency` (proxy for concurrently-staged bytes)', async () => {
    await withDriver('local', async (driver) => {
      const CONCURRENCY = 3;
      const ITEM_COUNT = 6;
      for (let i = 0; i < ITEM_COUNT; i += 1) {
        await seedAttachment(driver, { originalBytes: await rasterJpeg(SMALL_JPEG_WIDTH, SMALL_JPEG_HEIGHT) });
      }

      const original = imageDisplayDerivative.generateAndPublishDisplayDerivative;
      let current = 0;
      let max = 0;
      const spy = jest.spyOn(imageDisplayDerivative, 'generateAndPublishDisplayDerivative').mockImplementation(async (params) => {
        current += 1;
        max = Math.max(max, current);
        try {
          await new Promise((r) => setTimeout(r, 15));
          return await original(params);
        } finally {
          current -= 1;
        }
      });

      const runner = makeFakeRunner(CONCURRENCY);
      const stats = await runAttachmentDisplayDerivativesRebuild(crowi, {}, makeCtx(false), runner, AMPLE_FREE_BYTES);

      expect(stats).toMatchObject({ scanned: ITEM_COUNT });
      expect(max).toBe(CONCURRENCY);
      spy.mockRestore();
    });
  });

  it('stops accepting new items once aborted (simulated SIGINT), finishing only the in-flight item', async () => {
    await withDriver('local', async (driver) => {
      const items = await Promise.all(Array.from({ length: 5 }, () => seedAttachment(driver, { originalBytes: undefined /* default large jpeg */ })));
      const runner = makeFakeRunner(1); // serial — deterministic abort boundary
      runner.setAborted(false);

      const original = imageDisplayDerivative.generateAndPublishDisplayDerivative;
      let calls = 0;
      const spy = jest.spyOn(imageDisplayDerivative, 'generateAndPublishDisplayDerivative').mockImplementation(async (params) => {
        calls += 1;
        const result = await original(params);
        if (calls === 1) runner.setAborted(true);
        return result;
      });

      // `crowi.tmpDir` is a single fixed, process-shared directory (not
      // per-test-unique) — other test FILES running concurrently in sibling
      // jest workers may legitimately stage their own tmp files there at the
      // same wall-clock moment. Snapshot before/after and assert OUR OWN run
      // added no net new entries, rather than asserting global emptiness
      // (which would spuriously fail on unrelated concurrent activity).
      const before = new Set(await readTmpDirEntries());
      const stats = await runAttachmentDisplayDerivativesRebuild(crowi, {}, makeCtx(false), runner, AMPLE_FREE_BYTES);
      const after = await readTmpDirEntries();

      expect(stats.interrupted).toBe(true);
      expect(stats.scanned).toBe(1);
      spy.mockRestore();

      // The 4 untouched attachments still have no `derivatives.display`.
      const untouched = items.slice(1);
      for (const { attachment } of untouched) {
        const reloaded = await crowi.model('Attachment').findById(attachment._id);
        expect(reloaded?.derivatives).toBeUndefined();
      }
      expect(after.filter((f) => !before.has(f))).toEqual([]);
    });
  });
});

// ---------------------------------------------------------------------------
// repair-missing mode
// ---------------------------------------------------------------------------

describe('runAttachmentDisplayDerivativesRebuild — repair-missing mode', () => {
  it('skips (existence-only probe, no re-decode) when the resized object is actually present', async () => {
    await withDriver('local', async (driver) => {
      const { attachment, pageId } = await seedAttachment(driver, {});
      // Publish a real derivative first via generate mode.
      await runAttachmentDisplayDerivativesRebuild(crowi, {}, makeCtx(false), makeFakeRunner(2), AMPLE_FREE_BYTES);
      const afterGenerate = await crowi.model('Attachment').findById(attachment._id);
      const derivativeKey = afterGenerate?.derivatives?.display?.filePath as string;
      expect(derivativeKey).toBe(buildDisplayDerivativeKey(pageId, attachment._id, 'jpg'));

      const spy = jest.spyOn(imageDisplayDerivative, 'generateAndPublishDisplayDerivative');
      const stats = await runAttachmentDisplayDerivativesRebuild(crowi, { repairMissing: true }, makeCtx(false), makeFakeRunner(2), AMPLE_FREE_BYTES);

      expect(stats).toMatchObject({ mode: 'repair-missing', checked: 1, stillPresent: 1, repaired: 0, missingAndRepaired: 0, failed: 0 });
      expect(spy).not.toHaveBeenCalled();
      spy.mockRestore();

      // The object's content is unchanged (never re-decoded/re-encoded).
      await expect(driver.get(derivativeKey)).resolves.toBeDefined();
    });
  });

  it('regenerates only when the resized object is actually missing (ENOENT/NoSuchKey)', async () => {
    await withDriver('local', async (driver) => {
      const { attachment } = await seedAttachment(driver, {});
      await runAttachmentDisplayDerivativesRebuild(crowi, {}, makeCtx(false), makeFakeRunner(2), AMPLE_FREE_BYTES);
      const afterGenerate = await crowi.model('Attachment').findById(attachment._id);
      const derivativeKey = afterGenerate?.derivatives?.display?.filePath as string;

      // Simulate the object being lost (e.g. a storage migration that didn't
      // copy derivatives — spec §やらないこと).
      await driver.delete(derivativeKey);
      await expectMissingObject('local', driver.get(derivativeKey));

      const stats = await runAttachmentDisplayDerivativesRebuild(crowi, { repairMissing: true }, makeCtx(false), makeFakeRunner(2), AMPLE_FREE_BYTES);
      expect(stats).toMatchObject({ mode: 'repair-missing', checked: 1, stillPresent: 0, repaired: 1, missingAndRepaired: 1, failed: 0 });

      // The object genuinely exists again and decodes correctly.
      const reloaded = await crowi.model('Attachment').findById(attachment._id);
      expect(reloaded?.derivatives?.display?.mode).toBe('resized');
      const stream = await driver.get(reloaded?.derivatives?.display?.filePath as string);
      const chunks: Buffer[] = [];
      for await (const chunk of stream) chunks.push(chunk as Buffer);
      const meta = await sharp(Buffer.concat(chunks)).metadata();
      expect(meta.width).toBe(1728);
    });
  });

  it('dry-run counts a missing object as `repaired` but performs no actual regeneration', async () => {
    await withDriver('local', async (driver) => {
      const { attachment } = await seedAttachment(driver, {});
      await runAttachmentDisplayDerivativesRebuild(crowi, {}, makeCtx(false), makeFakeRunner(2), AMPLE_FREE_BYTES);
      const afterGenerate = await crowi.model('Attachment').findById(attachment._id);
      const derivativeKey = afterGenerate?.derivatives?.display?.filePath as string;
      await driver.delete(derivativeKey);

      const stats = await runAttachmentDisplayDerivativesRebuild(crowi, { repairMissing: true }, makeCtx(true), makeFakeRunner(2), AMPLE_FREE_BYTES);
      expect(stats).toMatchObject({ repaired: 1, missingAndRepaired: 0 });

      await expectMissingObject('local', driver.get(derivativeKey)); // still missing — dry-run wrote nothing
    });
  });

  it('records a non-missing storage error (e.g. connectivity) as a failure, not a repair', async () => {
    await withDriver('local', async (driver) => {
      const { attachment } = await seedAttachment(driver, {});
      await runAttachmentDisplayDerivativesRebuild(crowi, {}, makeCtx(false), makeFakeRunner(2), AMPLE_FREE_BYTES);
      const afterGenerate = await crowi.model('Attachment').findById(attachment._id);
      expect(afterGenerate?.derivatives?.display?.mode).toBe('resized');

      const getSpy = jest.spyOn(driver, 'get').mockRejectedValueOnce(new Error('connection reset'));
      const stats = await runAttachmentDisplayDerivativesRebuild(crowi, { repairMissing: true }, makeCtx(false), makeFakeRunner(2), AMPLE_FREE_BYTES);
      expect(stats).toMatchObject({ failed: 1, stillPresent: 0, repaired: 0 });
      if (stats.mode !== 'repair-missing') throw new Error('unreachable');
      expect(stats.failures).toEqual([{ attachmentId: String(attachment._id), reason: 'existence-check-error' }]);
      getSpy.mockRestore();
    });
  });

  it('only targets current-recipe `resized` records (a passthrough/unsupported/failed row is never in scope)', async () => {
    await withDriver('local', async (driver) => {
      await seedAttachment(driver, {
        display: { recipeVersion: DISPLAY_DERIVATIVE_RECIPE_VERSION, mode: 'passthrough', reason: 'within-target-width', generatedAt: new Date() },
      });
      const stats = await runAttachmentDisplayDerivativesRebuild(crowi, { repairMissing: true }, makeCtx(false), makeFakeRunner(2), AMPLE_FREE_BYTES);
      expect(stats).toMatchObject({ checked: 0 });
    });
  });
});

// ---------------------------------------------------------------------------
// gc mode (local driver only)
// ---------------------------------------------------------------------------

describe('runAttachmentDisplayDerivativesRebuild — gc mode', () => {
  it('reports candidates only by default — no deletion, even without --dry-run', async () => {
    await withDriver('local', async (driver, localRoot) => {
      if (!localRoot) throw new Error('unreachable');
      const { attachment, pageId } = await seedAttachment(driver, {});
      await runAttachmentDisplayDerivativesRebuild(crowi, {}, makeCtx(false), makeFakeRunner(2), AMPLE_FREE_BYTES);
      const referencedKey = (await crowi.model('Attachment').findById(attachment._id))?.derivatives?.display?.filePath as string;

      // An orphan derivative object with no referencing Attachment.
      const orphanAttachmentId = new Types.ObjectId();
      const orphanKey = buildDisplayDerivativeKey(pageId, orphanAttachmentId, 'jpg');
      await driver.put(orphanKey, Buffer.from('orphaned bytes'), { contentType: 'image/jpeg' });
      // Backdate its mtime past the default 24h grace period.
      const past = new Date(Date.now() - (DEFAULT_GC_GRACE_HOURS + 1) * 60 * 60 * 1000);
      await fs.utimes(path.join(localRoot, orphanKey), past, past);

      const stats = await runAttachmentDisplayDerivativesRebuild(crowi, { gc: true }, makeCtx(false), makeFakeRunner(2), AMPLE_FREE_BYTES);
      expect(stats).toMatchObject({ mode: 'gc', supported: true, candidateCount: 1, reclaimedCount: 0 });

      // Nothing was actually deleted.
      await expect(driver.get(orphanKey)).resolves.toBeDefined();
      await expect(driver.get(referencedKey)).resolves.toBeDefined();
    });
  });

  it('--confirm actually deletes reported candidates, leaving referenced objects untouched', async () => {
    await withDriver('local', async (driver, localRoot) => {
      if (!localRoot) throw new Error('unreachable');
      const { attachment, pageId } = await seedAttachment(driver, {});
      await runAttachmentDisplayDerivativesRebuild(crowi, {}, makeCtx(false), makeFakeRunner(2), AMPLE_FREE_BYTES);
      const referencedKey = (await crowi.model('Attachment').findById(attachment._id))?.derivatives?.display?.filePath as string;

      const orphanKey = buildDisplayDerivativeKey(pageId, new Types.ObjectId(), 'jpg');
      const orphanBytes = Buffer.from('orphaned bytes');
      await driver.put(orphanKey, orphanBytes, { contentType: 'image/jpeg' });
      const past = new Date(Date.now() - (DEFAULT_GC_GRACE_HOURS + 1) * 60 * 60 * 1000);
      await fs.utimes(path.join(localRoot, orphanKey), past, past);

      const stats = await runAttachmentDisplayDerivativesRebuild(crowi, { gc: true, confirm: true }, makeCtx(false), makeFakeRunner(2), AMPLE_FREE_BYTES);
      expect(stats).toMatchObject({ candidateCount: 1, reclaimedCount: 1, reclaimedBytes: orphanBytes.length });

      await expectMissingObject('local', driver.get(orphanKey));
      await expect(driver.get(referencedKey)).resolves.toBeDefined();
    });
  });

  it('a dry-run + --confirm combination still deletes nothing (dry-run wins)', async () => {
    await withDriver('local', async (driver, localRoot) => {
      if (!localRoot) throw new Error('unreachable');
      const pageId = new Types.ObjectId();
      const orphanKey = buildDisplayDerivativeKey(pageId, new Types.ObjectId(), 'jpg');
      await driver.put(orphanKey, Buffer.from('x'), { contentType: 'image/jpeg' });
      const past = new Date(Date.now() - (DEFAULT_GC_GRACE_HOURS + 1) * 60 * 60 * 1000);
      await fs.utimes(path.join(localRoot, orphanKey), past, past);

      const stats = await runAttachmentDisplayDerivativesRebuild(crowi, { gc: true, confirm: true }, makeCtx(true), makeFakeRunner(2), AMPLE_FREE_BYTES);
      expect(stats).toMatchObject({ candidateCount: 1, reclaimedCount: 0 });
      await expect(driver.get(orphanKey)).resolves.toBeDefined();
    });
  });

  it('excludes candidates newer than the default 24h grace period (race safety against an in-flight put→publish)', async () => {
    await withDriver('local', async (driver) => {
      const pageId = new Types.ObjectId();
      const freshOrphanKey = buildDisplayDerivativeKey(pageId, new Types.ObjectId(), 'jpg');
      await driver.put(freshOrphanKey, Buffer.from('x'), { contentType: 'image/jpeg' }); // mtime = now

      const stats = await runAttachmentDisplayDerivativesRebuild(crowi, { gc: true }, makeCtx(false), makeFakeRunner(2), AMPLE_FREE_BYTES);
      expect(stats).toMatchObject({ candidateCount: 0 });
    });
  });

  it('`--gc-grace-hours` overrides the default grace window', async () => {
    await withDriver('local', async (driver, localRoot) => {
      if (!localRoot) throw new Error('unreachable');
      const pageId = new Types.ObjectId();
      const orphanKey = buildDisplayDerivativeKey(pageId, new Types.ObjectId(), 'jpg');
      await driver.put(orphanKey, Buffer.from('x'), { contentType: 'image/jpeg' });
      const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000);
      await fs.utimes(path.join(localRoot, orphanKey), twoHoursAgo, twoHoursAgo);

      // Default 24h grace still excludes it.
      const defaultStats = await runAttachmentDisplayDerivativesRebuild(crowi, { gc: true }, makeCtx(false), makeFakeRunner(2), AMPLE_FREE_BYTES);
      expect(defaultStats).toMatchObject({ candidateCount: 0 });

      // A 1h grace window includes it.
      const shortGraceStats = await runAttachmentDisplayDerivativesRebuild(
        crowi,
        { gc: true, gcGraceHours: 1 },
        makeCtx(false),
        makeFakeRunner(2),
        AMPLE_FREE_BYTES,
      );
      expect(shortGraceStats).toMatchObject({ candidateCount: 1 });
    });
  });

  it('reports "unsupported" and exits cleanly on the S3 driver (no throw)', async () => {
    await withDriver('s3', async () => {
      const stats = await runAttachmentDisplayDerivativesRebuild(crowi, { gc: true }, makeCtx(false), makeFakeRunner(2), AMPLE_FREE_BYTES);
      expect(stats).toMatchObject({ mode: 'gc', supported: false, candidateCount: 0, reclaimedCount: 0 });
    });
  });
});

// ---------------------------------------------------------------------------
// local + S3 integration (AC: generate / skip / --force / --repair-missing /
// rebuild-vs-delete concurrent execution produces no orphans on either driver)
// ---------------------------------------------------------------------------

describe.each<DriverKind>(['local', 's3'])('rebuild integration — driver: %s', (kind) => {
  it('generates on first run, skips on rerun, --force re-evaluates, --repair-missing heals a lost object', async () => {
    await withDriver(kind, async (driver) => {
      const { attachment, pageId } = await seedAttachment(driver, {});
      const runner = makeFakeRunner(2);

      const firstRun = await runAttachmentDisplayDerivativesRebuild(crowi, {}, makeCtx(false), runner, AMPLE_FREE_BYTES);
      expect(firstRun).toMatchObject({ generated: 1, scanned: 1 });
      const derivativeKey = buildDisplayDerivativeKey(pageId, attachment._id, 'jpg');
      const readBack = await driver.get(derivativeKey);
      const chunks: Buffer[] = [];
      for await (const chunk of readBack) chunks.push(chunk as Buffer);
      expect((await sharp(Buffer.concat(chunks)).metadata()).width).toBe(1728);

      const rerun = await runAttachmentDisplayDerivativesRebuild(crowi, {}, makeCtx(false), runner, AMPLE_FREE_BYTES);
      expect(rerun).toMatchObject({ scanned: 1, skippedCurrent: 1, generated: 0 });

      const forced = await runAttachmentDisplayDerivativesRebuild(crowi, { force: true }, makeCtx(false), runner, AMPLE_FREE_BYTES);
      expect(forced).toMatchObject({ scanned: 1, skippedCurrent: 0, generated: 1 });

      await driver.delete(derivativeKey);
      const repaired = await runAttachmentDisplayDerivativesRebuild(crowi, { repairMissing: true }, makeCtx(false), runner, AMPLE_FREE_BYTES);
      expect(repaired).toMatchObject({ checked: 1, missingAndRepaired: 1 });
      await expect(driver.get(derivativeKey)).resolves.toBeDefined();
    });
  });

  it('a decode failure is retried (not skipped) on the next normal rerun', async () => {
    await withDriver(kind, async (driver) => {
      const { attachment } = await seedAttachment(driver, { originalBytes: Buffer.from('not an image'), fileFormat: 'image/jpeg' });
      const runner = makeFakeRunner(2);

      const first = await runAttachmentDisplayDerivativesRebuild(crowi, {}, makeCtx(false), runner, AMPLE_FREE_BYTES);
      expect(first).toMatchObject({ failed: 1, skippedCurrent: 0 });

      const second = await runAttachmentDisplayDerivativesRebuild(crowi, {}, makeCtx(false), runner, AMPLE_FREE_BYTES);
      expect(second).toMatchObject({ scanned: 1, skippedCurrent: 0, failed: 1 });

      const reloaded = await crowi.model('Attachment').findById(attachment._id);
      expect(reloaded?.derivatives?.display).toMatchObject({ mode: 'failed', reason: 'decode-error' });
    });
  });

  // AC9 — "rebuild と削除の並行実行" must be a GENUINE race between the
  // ACTUAL `Attachment.updateOne` (the rebuild task's publish, reached via
  // `generateAndPublishDisplayDerivative`) and `Attachment.findOneAndDelete`
  // (`removeAttachment`'s row deletion) Mongo calls — not just two async
  // functions kicked off together via `Promise.all`. The rebuild worker does
  // real work (stage the original, decode, resize, re-encode, storage `put`)
  // before it ever calls `updateOne`, while `removeAttachment`'s
  // `findOneAndDelete` is the very FIRST thing it does — so a naive
  // `Promise.all` of the two top-level calls collapses to the exact same
  // ordering on every run (delete always commits first) and never actually
  // exercises the "publish lands mid-delete" direction. Both sub-tests below
  // use `jest.spyOn(...).mockImplementationOnce(...)` (the same
  // race-injection idiom `image-display-derivative.test.ts`'s own case
  // C-1/C-2, and `models/page.test.ts`, use) to force the two Mongo calls to
  // interleave in a SPECIFIC, controlled order — deterministically
  // exercising both directions of the race instead of leaving it to chance.

  it("rebuild-publish-wins: the rebuild task's publish `updateOne` is forced to commit WHILE a concurrent `removeAttachment`'s `findOneAndDelete` is in flight (forced interleave, not pre-sequenced) — `findOneAndDelete` captures the freshly-published derivative and both original + derivative are removed (no orphan)", async () => {
    await withDriver(kind, async (driver) => {
      const { attachment, pageId } = await seedAttachment(driver, {});
      const runner = makeFakeRunner(2);
      const Attachment = crowi.model('Attachment');
      const realFindOneAndDelete = Attachment.findOneAndDelete.bind(Attachment);

      let rebuildStats: Awaited<ReturnType<typeof runAttachmentDisplayDerivativesRebuild>> | undefined;
      const findOneAndDeleteSpy = jest
        .spyOn(Attachment, 'findOneAndDelete')
        .mockImplementationOnce(async (...args: Parameters<typeof realFindOneAndDelete>) => {
          // Before the row is actually deleted, let the rebuild task's full
          // stage -> generate -> publish land on THIS SAME `_id` — the real
          // `findOneAndDelete` below is what must observe it, not a
          // caller-supplied stale snapshot.
          rebuildStats = await runAttachmentDisplayDerivativesRebuild(crowi, { pageId: pageId.toString() }, makeCtx(false), runner, AMPLE_FREE_BYTES);
          return realFindOneAndDelete(...args);
        });

      try {
        await Attachment.removeAttachment(attachment);
      } finally {
        findOneAndDeleteSpy.mockRestore();
      }

      expect(rebuildStats).toMatchObject({ mode: 'generate', scanned: 1, generated: 1 });

      expect(await Attachment.findById(attachment._id)).toBeNull();
      for (const key of displayDerivativeKeyCandidates(pageId, attachment._id)) {
        await expectMissingObject(kind, driver.get(key));
      }
    });
  });

  it("rebuild-delete-wins: a concurrent `removeAttachment` is forced to commit WHILE the rebuild task's publish `updateOne` is in flight (forced interleave, not pre-sequenced) — the rebuild's own compensating delete (matchedCount === 0) removes its just-put derivative, leaving no orphan", async () => {
    await withDriver(kind, async (driver) => {
      const { attachment, pageId } = await seedAttachment(driver, {});
      const runner = makeFakeRunner(2);
      const Attachment = crowi.model('Attachment');
      const realUpdateOne = Attachment.updateOne.bind(Attachment);

      const updateOneSpy = jest.spyOn(Attachment, 'updateOne').mockImplementationOnce(async (...args: Parameters<typeof realUpdateOne>) => {
        // Before the rebuild's conditional publish reaches Mongo, let a
        // concurrent delete commit first — `removeAttachment`'s own
        // deterministic-key sweep removes the derivative object `put`
        // already wrote to storage (`put` always runs before `updateOne` in
        // `generateAndPublishDisplayDerivative`).
        await Attachment.removeAttachment(attachment);
        return realUpdateOne(...args);
      });

      let stats: Awaited<ReturnType<typeof runAttachmentDisplayDerivativesRebuild>>;
      try {
        stats = await runAttachmentDisplayDerivativesRebuild(crowi, { pageId: pageId.toString() }, makeCtx(false), runner, AMPLE_FREE_BYTES);
      } finally {
        updateOneSpy.mockRestore();
      }

      // The generator's `put` still ran to completion — only the publish
      // itself lost the race (`matchedCount === 0`, since the row is
      // already gone). The rebuild task's `!result.published` handling
      // (see `processGenerateItem`) means this is correctly NOT counted as
      // `generated` — nothing was actually persisted onto a live row.
      expect(stats).toMatchObject({ mode: 'generate', scanned: 1, generated: 0, failed: 0 });

      expect(await Attachment.findById(attachment._id)).toBeNull();
      for (const key of displayDerivativeKeyCandidates(pageId, attachment._id)) {
        await expectMissingObject(kind, driver.get(key));
      }
    });
  });
});

// ---------------------------------------------------------------------------
// Dispatcher wiring — `attachmentDisplayDerivativesRebuild` (migration/rebuilds)
// through the REAL `RebuildRunner` (SIGINT handler install/dispose,
// ctx/runner threading), not just the low-level function called directly.
// ---------------------------------------------------------------------------

describe('attachmentDisplayDerivativesRebuild (dispatcher) + RebuildRunner', () => {
  it('runs generate mode end-to-end through the real runner and surfaces stats via RebuildOutcome', async () => {
    await withDriver('local', async (driver) => {
      await seedAttachment(driver, {});
      const runner = new RebuildRunner(crowi, { concurrency: 2 });

      const outcome = await runner.run(attachmentDisplayDerivativesRebuild({}));

      expect(outcome.id).toBe('attachment-display-derivatives');
      expect(outcome.interrupted).toBe(false);
      expect(outcome.stats).toMatchObject({ mode: 'generate', scanned: 1, generated: 1 });
    });
  });

  it('dispatches to gc mode when `gc: true` is set', async () => {
    await withDriver('local', async () => {
      const runner = new RebuildRunner(crowi, { concurrency: 2 });
      const outcome = await runner.run(attachmentDisplayDerivativesRebuild({ gc: true }));
      expect(outcome.stats).toMatchObject({ mode: 'gc', supported: true, candidateCount: 0 });
    });
  });

  // AC6 — drives the REAL `process.on('SIGINT', ...)` handler
  // `RebuildRunner.run()` installs (`MigrationRunnerCore.installSigintHandler`),
  // not a hand-set `aborted` flag on a fake runner (the `makeFakeRunner`-based
  // test above stays as cheap low-level coverage of `forEachBounded`'s own
  // abort-check placement). `jest.spyOn(process, 'on')` here still calls
  // through to the REAL `process.on` (no `mockImplementation`), so the actual
  // registration this codebase relies on in production genuinely happens —
  // the spy exists only to grab a reference to the listener function so this
  // test can invoke it directly, exactly as the OS would.
  //
  // A genuine self-directed `process.kill(process.pid, 'SIGINT')` was tried
  // first and rejected: when Jest is invoked against a single/few matched
  // test file(s) it runs them IN-BAND in the SAME process as the Jest CLI
  // itself (no worker child process), so that call hit the CLI's own
  // process and could tear down the entire test run out from under this
  // file — confirmed empirically while developing this test (`Command
  // failed with signal "SIGINT"` from the top-level `jest` process, before a
  // single assertion ran). Invoking the captured real handler function
  // exercises the identical code path an actual signal would (flip
  // `abortRequested`, self-uninstall via `removeSigintHandler()`) without
  // that risk.
  //
  // This is a CHEAP, low-level companion to the genuinely-separate-process
  // test below ("a real SIGINT sent to a genuinely separate process ...") —
  // THAT test is the one that actually proves a real OS signal produces a
  // real non-zero process exit code + a real printed progress summary + real
  // on-disk tmp cleanup, none of which this in-process test can observe
  // (`outcome.interrupted` is read off an in-memory object here, and
  // `attachmentDisplayDerivativesExitCode`'s mapping is unit-tested
  // separately in `@crowi/admin-cli`'s own `rebuild.test.ts` — this test
  // never actually maps to a process exit code at all).
  it("RebuildRunner's REAL installSigintHandler() handler (captured via a pass-through `process.on` spy, then invoked directly instead of an unsafe self-`kill()`) interrupts an in-flight run end-to-end: the outcome is marked interrupted, the in-flight item still completes (its staged tmp file cleaned up), untouched items are never pulled into a worker, and the listener uninstalls itself again afterward", async () => {
    await withDriver('local', async (driver) => {
      const items = await Promise.all(Array.from({ length: 3 }, () => seedAttachment(driver, {})));
      const runner = new RebuildRunner(crowi, { concurrency: 1 }); // serial — deterministic interrupt boundary

      const onSpy = jest.spyOn(process, 'on');
      let sigintHandler: (() => void) | undefined;

      const original = imageDisplayDerivative.generateAndPublishDisplayDerivative;
      let calls = 0;
      const spy = jest.spyOn(imageDisplayDerivative, 'generateAndPublishDisplayDerivative').mockImplementation(async (params) => {
        calls += 1;
        if (calls === 1) {
          const registration = onSpy.mock.calls.find(([event]) => event === 'SIGINT');
          if (!registration) throw new Error('unreachable: RebuildRunner.run() never registered a SIGINT handler via process.on');
          sigintHandler = registration[1] as () => void;
          sigintHandler();
        }
        return original(params);
      });

      const listenersBefore = process.listenerCount('SIGINT');
      const before = new Set(await readTmpDirEntries());
      const outcome = await runner.run(attachmentDisplayDerivativesRebuild({}));
      const after = await readTmpDirEntries();
      spy.mockRestore();
      onSpy.mockRestore();

      expect(sigintHandler).toBeDefined();
      expect(outcome.interrupted).toBe(true);
      expect(outcome.stats).toMatchObject({ mode: 'generate', scanned: 1 });
      // `attachmentDisplayDerivativesExitCode` (admin-cli,
      // `packages/admin-cli/src/commands/rebuild.ts`) maps `interrupted: true`
      // to a non-zero exit code (130) — that pure mapping is covered by its
      // own test suite (`rebuild.test.ts`); asserted here only up to the
      // `outcome.interrupted` input it consumes, to keep this api-package
      // test free of a cross-package import into `@crowi/admin-cli`.

      // The one in-flight item still ran to completion (SIGINT only stops
      // accepting NEW items) and its staged tmp file was cleaned up in
      // `stageAndGenerate`'s `finally`; the 2 untouched items were never
      // pulled into a worker at all.
      expect(after.filter((f) => !before.has(f))).toEqual([]);
      const untouched = items.slice(1);
      for (const { attachment } of untouched) {
        const reloaded = await crowi.model('Attachment').findById(attachment._id);
        expect(reloaded?.derivatives).toBeUndefined();
      }

      // The handler removed itself the moment it ran (this phase's
      // `runner.ts` fix — see its own doc comment) — assert the listener
      // count returns to whatever it was before (not a hardcoded 0, since
      // other machinery may hold unrelated listeners), proving no leak
      // survives an interrupted run.
      expect(process.listenerCount('SIGINT')).toBe(listenersBefore);
    });
  });
});

// ---------------------------------------------------------------------------
// AC6 — a REAL OS SIGINT delivered to a REAL, genuinely separate process
// running the same production wiring the CLI uses (see
// `rebuild-attachment-display-derivatives-sigint-harness.ts`'s own doc
// comment for the full design rationale and why it reconstructs the CLI's
// wiring rather than spawning the built `crowi-admin` binary).
// ---------------------------------------------------------------------------

/** Absolute path to the `tsx` CLI entry — same helper every other `tsx`-spawned harness in this package defines locally (`storage-local.test.ts`, `collab/redis-smoke-harness-client.ts`). */
function resolveTsxCliForSigintHarness(): string {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  return require.resolve('tsx/cli');
}

interface SigintHarnessResult {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
}

/**
 * Spawns `rebuild-attachment-display-derivatives-sigint-harness.ts` as a
 * genuinely separate OS process and sends it a REAL `SIGINT` the moment its
 * FIRST `{"itemStarted": ...}` stdout line appears — proving the signal
 * lands after the run has genuinely begun, not racing the harness's own
 * (Mongo-connecting) startup. Resolves once the process has both exited AND
 * closed its stdio streams (`'close'`, not `'exit'` — the latter can fire
 * before the last buffered stdout write is fully delivered to this parent).
 */
function runSigintHarnessKillingOnFirstItem(env: Record<string, string>): Promise<SigintHarnessResult> {
  return new Promise((resolve, reject) => {
    const harnessPath = path.join(__dirname, 'rebuild-attachment-display-derivatives-sigint-harness.ts');
    const child: ChildProcessByStdio<null, Readable, Readable> = spawn(resolveTsxCliForSigintHarness(), [harnessPath], {
      env: { ...process.env, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    let sentSigint = false;
    const rl = readline.createInterface({ input: child.stdout });
    rl.on('line', (line) => {
      stdout += `${line}\n`;
      if (!sentSigint && line.includes('"itemStarted"')) {
        sentSigint = true;
        child.kill('SIGINT');
      }
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
    });
    child.once('error', reject);
    child.once('close', (code, signal) => {
      rl.close();
      resolve({ code, signal, stdout, stderr });
    });
  });
}

describe('rebuild attachment-display-derivatives — SIGINT via a genuine OS signal to a separate, CLI-shaped process (AC6)', () => {
  it('a real SIGINT sent to a genuinely separate process stops new-item intake, lets the in-flight item finish (cleaning up its own staged tmp file), prints a progress summary, and exits non-zero', async () => {
    const localRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'crowi-rebuild-sigint-storage-'));
    const harnessRootDir = await fs.mkdtemp(path.join(os.tmpdir(), 'crowi-rebuild-sigint-root-'));
    try {
      const driver = createLocalDriver({ rootDir: localRoot });
      // Enough items (real 2000x1000 JPEGs, each genuinely decoded /
      // resized / re-encoded by sharp + published via a real Mongo
      // `updateOne`) that the whole serial (`concurrency=1`) run takes
      // comfortably longer than the IPC round trip from "first item
      // started" stdout line to `child.kill('SIGINT')` actually landing.
      // The assertions below only need "not every item was processed" +
      // "no new items after the abort", not an exact item-count boundary,
      // so this generous item count trades a little wall-clock time for a
      // non-flaky margin instead of a razor-thin one.
      const ITEM_COUNT = 20;
      const seeded = await Promise.all(Array.from({ length: ITEM_COUNT }, () => seedAttachment(driver, {})));

      const result = await runSigintHarnessKillingOnFirstItem({
        CROWI_REBUILD_SIGINT_HARNESS_ROOT_DIR: harnessRootDir,
        CROWI_REBUILD_SIGINT_HARNESS_STORAGE_ROOT: localRoot,
        CROWI_REBUILD_SIGINT_HARNESS_CONCURRENCY: '1',
        MONGO_URI,
      });

      // `initForCli()` deliberately routes its own boot noise (env
      // validation warnings, the "Loaded N plugin(s)" summary) to stderr
      // in non-production `cliContext` mode (`Crowi.setupPlugins()`) — a
      // real `crowi-admin` invocation prints exactly this, so stderr is
      // NOT expected to be empty. Only assert it carries no fatal error
      // from the harness's own top-level `.catch()`.
      expect(result.stderr).not.toContain('rebuild-attachment-display-derivatives-sigint-harness fatal');
      // A REAL non-zero process exit — the interrupted mapping (130 = 128
      // + SIGINT), not merely `outcome.interrupted === true` read off an
      // in-memory object.
      expect(result.code).toBe(130);
      // A REAL progress-summary was actually printed, not just held in a
      // stats object.
      expect(result.stdout).toContain('Interrupted by SIGINT before completion');

      // REAL on-disk tmp cleanup: the harness's OWN isolated tmpDir
      // (`<harnessRootDir>/tmp/`) has no leftover staged file, whether or
      // not it was ever created at all.
      const tmpEntries = await fs.readdir(path.join(harnessRootDir, 'tmp')).catch(() => [] as string[]);
      expect(tmpEntries.filter((f) => f.startsWith('rebuild-display-derivative-'))).toEqual([]);

      // New-item intake genuinely stopped: not every seeded attachment was
      // processed (some rows still have no `derivatives.display` at all).
      const reloaded = await Promise.all(seeded.map(({ attachment }) => crowi.model('Attachment').findById(attachment._id)));
      const untouchedCount = reloaded.filter((doc) => doc?.derivatives?.display === undefined).length;
      expect(untouchedCount).toBeGreaterThan(0);
    } finally {
      await fs.rm(localRoot, { recursive: true, force: true });
      await fs.rm(harnessRootDir, { recursive: true, force: true });
    }
  }, 30000);
});
