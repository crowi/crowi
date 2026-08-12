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

    registerFakeDriver(SRC_NAME, srcDriver);
    registerFakeDriver(DST_NAME, dstDriver);

    // Wipe Attachment / User collections that previous tests may have left.
    await crowi.model('Attachment').deleteMany({}).exec();
    await crowi
      .model('User')
      .deleteMany({ image: { $regex: 'user(%2F|/)', $options: 'i' } })
      .exec();
  });

  afterEach(() => {
    unregisterFakeDriver(SRC_NAME);
    unregisterFakeDriver(DST_NAME);
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
      { name: 'Pic User', username: 'picuser', email: 'pic@example.com', image: '/api/attachments/by-key/user%2Fabc.png' },
    ]);
    expect(user.image).toContain('user%2Fabc.png');

    const summary = await runStorageCopy(crowi, { from: SRC_NAME, to: DST_NAME, dryRun: false });

    expect(summary.ok).toBe(1);
    expect(readAt(dstRoot, 'user/abc.png')).toBe('profile-data');
  });

  test('copies a profile picture whose User.image still carries the legacy (pre-cutover) /api/v2/attachments/by-key/ prefix', async () => {
    // Regression: extractUserPictureKey() must recognise this legacy
    // by-key form regardless of the /api vs /api/v2 leading segment (the
    // encoded `user%2F...` key never matches the plain `user/<id>.<ext>`
    // fallback regex, so a producer-only prefix flip without this fix would
    // silently stop copying/discovering these rows).
    writeAt(srcRoot, 'user/legacy.png', 'legacy-profile-data');
    const [user] = await Fixture.generate('User', [
      { name: 'Legacy Pic User', username: 'legacypicuser', email: 'legacy-pic@example.com', image: '/api/v2/attachments/by-key/user%2Flegacy.png' },
    ]);
    expect(user.image).toContain('user%2Flegacy.png');

    const summary = await runStorageCopy(crowi, { from: SRC_NAME, to: DST_NAME, dryRun: false });

    expect(summary.ok).toBe(1);
    expect(readAt(dstRoot, 'user/legacy.png')).toBe('legacy-profile-data');
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

  /**
   * feature-storage-gcs AC-11: `runStorageCopy` is driver-neutral (spec
   * §"processing/data flow — storage copy と cutover": "production copy loop
   * に GCS 固有分岐は追加しない"). Real GCS CRUD/copy is covered by the opt-in
   * `storage-gcs.emulator.test.ts` suite (Phase 3); this nested describe
   * proves the neutral loop itself hands a GCS-shaped destination exactly
   * what it needs (source `Readable`, logical key, content type), destroys
   * the source on a destination failure, and lets a retried copy of the
   * same key overwrite — without depending on the real
   * `@crowi/plugin-storage-gcs` package. Nested (not a sibling `describe`)
   * so it can reuse the outer `beforeEach`'s `srcRoot`/`srcDriver`/`SRC_NAME`
   * fixture instead of duplicating it.
   */
  describe('GCS-like destination (feature-storage-gcs AC-11)', () => {
    const GCS_NAME = 'test-gcs-like';
    // Keyed by logical key (like a real key-addressed object store), not
    // appended to unconditionally — this is what lets the retry/overwrite
    // test below prove the SECOND write actually replaces the first rather
    // than merely existing alongside it.
    let gcsWrites: Map<string, { contentType: string; bytes: Buffer }>;
    let failNextPut: boolean;
    let gcsDriver: StorageDriver;

    beforeEach(() => {
      gcsWrites = new Map();
      failNextPut = false;
      gcsDriver = {
        async put(key, body, meta) {
          if (failNextPut) {
            failNextPut = false;
            throw Object.assign(new Error('simulated GCS destination failure'), { code: 500 });
          }
          const chunks: Buffer[] = [];
          for await (const chunk of body as Readable) chunks.push(chunk as Buffer);
          gcsWrites.set(key, { contentType: meta.contentType, bytes: Buffer.concat(chunks) });
          return { key };
        },
        async get() {
          throw new Error('not used as a copy source in this suite');
        },
        async delete() {
          /* not used in this suite */
        },
      };
      registerFakeDriver(GCS_NAME, gcsDriver);
    });

    afterEach(() => {
      unregisterFakeDriver(GCS_NAME);
    });

    /** Spies on `srcDriver.get`, delegating to the real implementation, and captures the exact stream instance it returned — for referential-equality assertions against what reaches the destination driver's `put()`. */
    function spyOnSourceGet(): { getSpy: jest.SpyInstance; getCapturedSource: () => Readable | undefined } {
      let capturedSource: Readable | undefined;
      const originalGet = srcDriver.get.bind(srcDriver);
      const getSpy = jest.spyOn(srcDriver, 'get').mockImplementation(async (key: string) => {
        const stream = (await originalGet(key)) as Readable;
        capturedSource = stream;
        return stream;
      });
      return { getSpy, getCapturedSource: () => capturedSource };
    }

    test('passes the source Readable, logical key, and content type through to the GCS-like put() unchanged — the exact same stream instance, not re-wrapped or copied', async () => {
      writeAt(srcRoot, 'attachment/g/file.txt', 'gcs-bound');
      await crowi.model('Attachment').create({ filePath: 'attachment/g/file.txt', fileName: 'file.txt', fileFormat: 'text/plain', fileSize: 9 });

      const { getSpy, getCapturedSource } = spyOnSourceGet();

      let capturedBody: unknown;
      const originalPut = gcsDriver.put.bind(gcsDriver);
      const putSpy = jest.spyOn(gcsDriver, 'put').mockImplementation(async (key, body, meta) => {
        capturedBody = body;
        return originalPut(key, body, meta);
      });

      const summary = await runStorageCopy(crowi, { from: SRC_NAME, to: GCS_NAME, dryRun: false });

      const capturedSource = getCapturedSource();
      expect(summary.ok).toBe(1);
      expect(summary.failed).toBe(0);
      expect(capturedSource).toBeDefined();
      // Referential equality, not just equal bytes: `runStorageCopy` must
      // hand the destination the exact stream `fromDriver.get()` returned,
      // never a re-wrapped/re-buffered copy of it.
      expect(capturedBody).toBe(capturedSource);
      expect(gcsWrites.get('attachment/g/file.txt')).toEqual({ contentType: 'text/plain', bytes: Buffer.from('gcs-bound') });
      getSpy.mockRestore();
      putSpy.mockRestore();
    });

    test('destroys the source stream when the GCS-like destination put() fails', async () => {
      writeAt(srcRoot, 'attachment/g/fail.txt', 'will-fail');
      await crowi.model('Attachment').create({ filePath: 'attachment/g/fail.txt', fileName: 'fail.txt', fileFormat: 'text/plain', fileSize: 9 });

      const { getSpy, getCapturedSource } = spyOnSourceGet();

      failNextPut = true;
      const summary = await runStorageCopy(crowi, { from: SRC_NAME, to: GCS_NAME, dryRun: false });

      expect(summary.ok).toBe(0);
      expect(summary.failed).toBe(1);
      expect(getCapturedSource()?.destroyed).toBe(true);
      getSpy.mockRestore();
    });

    test('a retried copy of the same key succeeds and OVERWRITES a previously-written GCS-like object, rather than erroring or leaving a stale duplicate', async () => {
      writeAt(srcRoot, 'attachment/g/retry.txt', 'first-attempt');
      await crowi.model('Attachment').create({ filePath: 'attachment/g/retry.txt', fileName: 'retry.txt', fileFormat: 'text/plain', fileSize: 13 });

      // Establish a genuine PRIOR successful write at this key first — the
      // property under test is overwrite semantics, which only means
      // something once something real already exists at the destination.
      const first = await runStorageCopy(crowi, { from: SRC_NAME, to: GCS_NAME, dryRun: false });
      expect(first.ok).toBe(1);
      expect(first.failed).toBe(0);
      expect(gcsWrites.get('attachment/g/retry.txt')).toEqual({ contentType: 'text/plain', bytes: Buffer.from('first-attempt') });

      // Simulate a retry of the same key (e.g. an operator re-running the
      // migration for idempotency, or retrying after a transient failure on
      // a different key) with updated source content. Same key, no distinct
      // "already exists" branch in either `runStorageCopy` or the GCS `put`
      // contract (complete-object replacement) — a plain re-run must
      // overwrite, not duplicate.
      writeAt(srcRoot, 'attachment/g/retry.txt', 'second-attempt');
      const second = await runStorageCopy(crowi, { from: SRC_NAME, to: GCS_NAME, dryRun: false });
      expect(second.ok).toBe(1);
      // Exactly one entry for this key — proves overwrite, not a second,
      // independently-addressable object alongside the first.
      expect(gcsWrites.size).toBe(1);
      expect(gcsWrites.get('attachment/g/retry.txt')).toEqual({ contentType: 'text/plain', bytes: Buffer.from('second-attempt') });
    });
  });
});

describe('util/storage-copy / extractUserPictureKey', () => {
  test('handles current by-key proxy URLs', () => {
    expect(extractUserPictureKey('/api/attachments/by-key/user%2Fabc.png')).toBe('user/abc.png');
  });

  test('handles legacy (pre-cutover) /api/v2/attachments/by-key/ proxy URLs', () => {
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

// Inject a driver into the registry's private map directly, because the
// public `register` API guards against duplicate registrations across tests.
function registerFakeDriver(name: string, driver: StorageDriver): void {
  const reg = crowi.getPlugins().storage as unknown as { drivers: Map<string, { plugin: string; driver: StorageDriver }> };
  reg.drivers.set(name, { plugin: 'test', driver });
}

function unregisterFakeDriver(name: string): void {
  const reg = crowi.getPlugins().storage as unknown as { drivers: Map<string, unknown> };
  reg.drivers.delete(name);
}

function writeAt(root: string, relPath: string, body: string) {
  const full = path.join(root, relPath);
  mkdirSync(path.dirname(full), { recursive: true });
  writeFileSync(full, body);
}

function readAt(root: string, relPath: string): string {
  return readFileSync(path.join(root, relPath), 'utf-8');
}
