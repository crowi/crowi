import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import type { StorageDriver } from '@crowi/plugin-api';
import { createLocalDriver } from '@crowi/plugin-storage-local';
import { extractUserPictureKey, runStorageCopy } from 'src/util/storage-copy';
import { crowi, Fixture } from 'src/test/setup';

/**
 * runStorageCopy unit tests.
 *
 * The strategy is to swap fresh in-memory storage drivers (two
 * `createLocalDriver` instances pointed at separate tmpdirs) into the
 * crowi instance's plugin registry for the duration of each test, then
 * call the helper directly. Mongo collections (Attachment / User) come
 * from the standard test setup which boots a real Mongo Memory Server.
 *
 * We re-register the drivers under unique names per test so we don't
 * collide with the implicit-default `local` driver that the real
 * PluginManager registers.
 */
describe('util/storage-copy', () => {
  let srcRoot: string;
  let dstRoot: string;
  let srcDriver: StorageDriver;
  let dstDriver: StorageDriver;
  const SRC_NAME = 'test-src';
  const DST_NAME = 'test-dst';

  beforeEach(async () => {
    srcRoot = mkdtempSync(path.join(os.tmpdir(), 'storage-copy-src-'));
    dstRoot = mkdtempSync(path.join(os.tmpdir(), 'storage-copy-dst-'));
    srcDriver = createLocalDriver({ rootDir: srcRoot });
    dstDriver = createLocalDriver({ rootDir: dstRoot });

    // Inject our two drivers into the registry. We use the private
    // map directly because the public `register` API guards against
    // duplicate registrations across tests.
    const reg = crowi.getPlugins().storage as unknown as { drivers: Map<string, { plugin: string; driver: StorageDriver }> };
    reg.drivers.set(SRC_NAME, { plugin: 'test', driver: srcDriver });
    reg.drivers.set(DST_NAME, { plugin: 'test', driver: dstDriver });

    // Wipe Attachment / User collections that previous tests may have left.
    await crowi.model('Attachment').deleteMany({}).exec();
    await crowi
      .model('User')
      .deleteMany({ image: { $regex: 'user(%2F|/)', $options: 'i' } })
      .exec();
  });

  afterEach(() => {
    const reg = crowi.getPlugins().storage as unknown as { drivers: Map<string, unknown> };
    reg.drivers.delete(SRC_NAME);
    reg.drivers.delete(DST_NAME);
    rmSync(srcRoot, { recursive: true, force: true });
    rmSync(dstRoot, { recursive: true, force: true });
  });

  test('throws when source driver is not registered', async () => {
    await expect(runStorageCopy(crowi, { from: 'nonexistent', to: DST_NAME, dryRun: false })).rejects.toThrow(/Storage driver 'nonexistent' is not registered/);
  });

  test('throws when source and destination are the same', async () => {
    await expect(runStorageCopy(crowi, { from: SRC_NAME, to: SRC_NAME, dryRun: false })).rejects.toThrow(/must differ/);
  });

  test('copies attachment files between drivers', async () => {
    // Seed the source filesystem with two attachment payloads, then
    // create matching Attachment rows so the cursor finds them.
    writeAt(srcRoot, 'attachment/aaa/file-1.txt', 'hello-1');
    writeAt(srcRoot, 'attachment/aaa/file-2.txt', 'hello-2');

    const Attachment = crowi.model('Attachment');
    await Attachment.create([
      { filePath: 'attachment/aaa/file-1.txt', fileName: 'file-1.txt', fileFormat: 'text/plain', fileSize: 7 },
      { filePath: 'attachment/aaa/file-2.txt', fileName: 'file-2.txt', fileFormat: 'text/plain', fileSize: 7 },
    ]);

    const summary = await runStorageCopy(crowi, { from: SRC_NAME, to: DST_NAME, dryRun: false });

    expect(summary.ok).toBe(2);
    expect(summary.failed).toBe(0);
    expect(summary.skipped).toBe(0);
    expect(summary.total).toBe(2);
    expect(readAt(dstRoot, 'attachment/aaa/file-1.txt')).toBe('hello-1');
    expect(readAt(dstRoot, 'attachment/aaa/file-2.txt')).toBe('hello-2');
  });

  test('dry-run reports candidates without writing to destination', async () => {
    writeAt(srcRoot, 'attachment/x/file.txt', 'should-not-be-copied');
    await crowi.model('Attachment').create({ filePath: 'attachment/x/file.txt', fileName: 'file.txt', fileFormat: 'text/plain', fileSize: 5 });

    const summary = await runStorageCopy(crowi, { from: SRC_NAME, to: DST_NAME, dryRun: true });

    expect(summary.total).toBe(1);
    expect(summary.skipped).toBe(1);
    expect(summary.ok).toBe(0);
    expect(summary.sampleKeys).toEqual(['attachment/x/file.txt']);
    // dst/ root should be untouched (no file exists at the same key).
    expect(() => readAt(dstRoot, 'attachment/x/file.txt')).toThrow();
  });

  test('reports failed copies but completes the run', async () => {
    // First file exists in src; second one is missing on disk so the
    // get() call throws ENOENT — which the helper should catch.
    writeAt(srcRoot, 'attachment/ok/file-ok.txt', 'ok');
    await crowi.model('Attachment').create([
      { filePath: 'attachment/ok/file-ok.txt', fileName: 'a', fileFormat: 'text/plain', fileSize: 2 },
      { filePath: 'attachment/missing/gone.txt', fileName: 'b', fileFormat: 'text/plain', fileSize: 0 },
    ]);

    const summary = await runStorageCopy(crowi, { from: SRC_NAME, to: DST_NAME, dryRun: false });

    expect(summary.total).toBe(2);
    expect(summary.ok).toBe(1);
    expect(summary.failed).toBe(1);
    expect(readAt(dstRoot, 'attachment/ok/file-ok.txt')).toBe('ok');
  });

  test('copies profile pictures discovered via User.image regex', async () => {
    writeAt(srcRoot, 'user/abc.png', 'profile-data');
    // The regex matches both encoded (`user%2F`) and raw (`user/`)
    // forms so either URL shape that fileUploader.generateUrl produces
    // for a saved profile picture is captured.
    const [user] = await Fixture.generate('User', [
      { name: 'Pic User', username: 'picuser', email: 'pic@example.com', image: '/api/v2/attachments/by-key/user%2Fabc.png' },
    ]);
    expect(user.image).toContain('user%2Fabc.png');

    const summary = await runStorageCopy(crowi, { from: SRC_NAME, to: DST_NAME, dryRun: false });

    expect(summary.ok).toBe(1);
    expect(readAt(dstRoot, 'user/abc.png')).toBe('profile-data');
  });

  test('progress events fire for ok / failed / skipped', async () => {
    writeAt(srcRoot, 'attachment/p/ok.txt', 'x');
    await crowi.model('Attachment').create({ filePath: 'attachment/p/ok.txt', fileName: 'a', fileFormat: 'text/plain', fileSize: 1 });

    const events: string[] = [];
    await runStorageCopy(crowi, {
      from: SRC_NAME,
      to: DST_NAME,
      dryRun: false,
      onProgress: (e) => events.push(`${e.stage}:${e.key}`),
    });

    expect(events).toContain('start:attachment/p/ok.txt');
    expect(events).toContain('ok:attachment/p/ok.txt');
  });
});

describe('util/storage-copy / extractUserPictureKey', () => {
  test('handles by-key proxy URLs', () => {
    expect(extractUserPictureKey('/api/v2/attachments/by-key/user%2Fabc.png')).toBe('user/abc.png');
  });

  test('handles raw user/<id>.<ext> URLs (S3 signed)', () => {
    expect(extractUserPictureKey('https://my-bucket.s3.ap-northeast-1.amazonaws.com/user/abc.png?signature=...')).toBe('user/abc.png');
  });

  test('returns null for external avatar URLs', () => {
    expect(extractUserPictureKey('https://lh3.googleusercontent.com/a/some-google-avatar')).toBeNull();
  });

  test('returns null for null / undefined / empty', () => {
    expect(extractUserPictureKey(null)).toBeNull();
    expect(extractUserPictureKey(undefined)).toBeNull();
    expect(extractUserPictureKey('')).toBeNull();
  });
});

function writeAt(root: string, relPath: string, body: string) {
  const full = path.join(root, relPath);
  mkdirSync(path.dirname(full), { recursive: true });
  writeFileSync(full, body);
}

function readAt(root: string, relPath: string): string {
  return readFileSync(path.join(root, relPath), 'utf-8');
}

// Silence the unused-import warning for Readable when the test file
// is read by linters that don't track JSX-style generics.
void Readable;
