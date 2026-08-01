import { createReadStream, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { StorageDriver } from '@crowi/plugin-api';
import { createLocalDriver } from '@crowi/plugin-storage-local';

import { crowi } from 'src/test/setup';
import FileUploader from 'src/util/file-uploader';

/**
 * Reproduces the api-process-crashing bug found during QA on
 * 2026-08-01: `@crowi/plugin-storage-aws-s3`'s `put()` (and, in general,
 * any driver) can reject BEFORE ever consuming the `body` stream it was
 * handed (`requireBucket()` throws synchronously when the bucket is
 * unconfigured, before `client.send(...)`). The attachment / avatar
 * upload handlers pass a bare `fs.createReadStream(tmpPath, { autoClose:
 * true })` as that body with no `'error'` listener attached. When the
 * driver never consumes the stream, its own internal `open()` still
 * completes asynchronously later; if the backing tmp file has by then
 * been unlinked by the caller's cleanup-on-error path, the stream emits
 * an unhandled `'error'` event — which is FATAL to the whole Node
 * process (unlike a rejected promise), not merely a failed request.
 *
 * `uploadFile` must attach a listener before ever handing the stream to
 * a driver, and must destroy the stream when the driver rejects, so this
 * can never happen regardless of which driver is active or how it fails.
 */
describe('util/file-uploader', () => {
  let srcTmpDir: string;
  let tmpFilePath: string;
  let storageRoot: string;

  beforeEach(() => {
    srcTmpDir = mkdtempSync(path.join(os.tmpdir(), 'crowi-file-uploader-test-'));
    tmpFilePath = path.join(srcTmpDir, 'source');
    writeFileSync(tmpFilePath, 'test upload content');
    storageRoot = mkdtempSync(path.join(os.tmpdir(), 'crowi-file-uploader-test-dest-'));
  });

  afterEach(() => {
    rmSync(srcTmpDir, { recursive: true, force: true });
    rmSync(storageRoot, { recursive: true, force: true });
  });

  it('attaches an error listener and destroys the stream when the driver rejects without consuming it', async () => {
    // Mirrors `requireBucket()` in @crowi/plugin-storage-aws-s3: rejects
    // synchronously, never touching `body`.
    const driverError = new Error('@crowi/plugin-storage-aws-s3: bucket is not configured.');
    const rejectingDriver: StorageDriver = {
      put: jest.fn().mockRejectedValue(driverError),
      get: jest.fn(),
      delete: jest.fn(),
    };

    const registries = crowi.getPlugins();
    const original = registries.active.storage;
    registries.active.storage = rejectingDriver;

    const stream = createReadStream(tmpFilePath, { flags: 'r', autoClose: true });
    const uploader = FileUploader(crowi);

    try {
      await expect(uploader.uploadFile('some/key', 'text/plain', stream, {})).rejects.toThrow(driverError);
    } finally {
      registries.active.storage = original;
    }

    // Before the fix: neither of these holds — the stream is handed to
    // the driver with no listener and is never cleaned up, so a later
    // ENOENT from its own delayed `open()` (e.g. after the caller's
    // cleanup-on-error unlinks the backing file) is unhandled and fatal.
    expect(stream.listenerCount('error')).toBeGreaterThan(0);
    expect(stream.destroyed).toBe(true);
  });

  it('still uploads successfully when the driver accepts the stream', async () => {
    const acceptingDriver: StorageDriver = {
      put: jest.fn().mockResolvedValue({ key: 'some/key' }),
      get: jest.fn(),
      delete: jest.fn(),
    };

    const registries = crowi.getPlugins();
    const original = registries.active.storage;
    registries.active.storage = acceptingDriver;

    const stream = createReadStream(tmpFilePath, { flags: 'r', autoClose: true });
    const uploader = FileUploader(crowi);

    try {
      await expect(uploader.uploadFile('some/key', 'text/plain', stream, {})).resolves.toEqual({ key: 'some/key' });
    } finally {
      registries.active.storage = original;
    }

    expect(acceptingDriver.put).toHaveBeenCalledWith('some/key', stream, { contentType: 'text/plain' });
  });

  it('round-trips real bytes through a driver that genuinely consumes the stream via a pipeline (e.g. the local driver)', async () => {
    // The stub-driver tests above only prove the call shape; this proves
    // the extra `'error'` listener + catch-time `destroy()` don't disturb
    // a driver that actually pipes the stream to completion.
    const localDriver = createLocalDriver({ rootDir: storageRoot });

    const registries = crowi.getPlugins();
    const original = registries.active.storage;
    registries.active.storage = localDriver;

    const stream = createReadStream(tmpFilePath, { flags: 'r', autoClose: true });
    const uploader = FileUploader(crowi);

    try {
      await expect(uploader.uploadFile('some/key.txt', 'text/plain', stream, {})).resolves.toEqual({ key: 'some/key.txt' });
    } finally {
      registries.active.storage = original;
    }

    const uploaded = await localDriver.get('some/key.txt');
    const chunks: Buffer[] = [];
    for await (const chunk of uploaded) chunks.push(chunk as Buffer);
    expect(Buffer.concat(chunks).toString()).toBe(readFileSync(tmpFilePath, 'utf8'));
  });

  it('attaches an error listener and destroys the stream even when no storage driver is registered at all', async () => {
    // `activeDriver()` throws synchronously in this case — the listener
    // must be attached before that throw is even possible, not just
    // before `driver.put()` (a driver-resolution failure is a distinct
    // early-throw case from a driver rejecting `put()`).
    const registries = crowi.getPlugins();
    const original = registries.active.storage;
    registries.active.storage = null;

    const stream = createReadStream(tmpFilePath, { flags: 'r', autoClose: true });
    const uploader = FileUploader(crowi);

    try {
      await expect(uploader.uploadFile('some/key', 'text/plain', stream, {})).rejects.toThrow(/Storage driver not registered/);
    } finally {
      registries.active.storage = original;
    }

    expect(stream.listenerCount('error')).toBeGreaterThan(0);
    expect(stream.destroyed).toBe(true);
  });
});
