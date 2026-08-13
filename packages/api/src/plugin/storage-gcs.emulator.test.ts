/**
 * Opt-in integration suite for `@crowi/plugin-storage-gcs` against a real
 * GCS-JSON-API-compatible server (`fsouza/fake-gcs-server`, pinned to
 * `1.54.0` — see `docker-compose.yml`'s `crowi-test-gcs` service, gated
 * behind the `gcs-test` profile). Skipped entirely unless
 * `STORAGE_EMULATOR_HOST` is set — this is NOT part of the normal
 * `pnpm --filter @crowi/api test` gate; fake-gcs-server must never become a
 * required service for normal CI.
 *
 *   docker compose --profile gcs-test up -d crowi-test-gcs
 *   STORAGE_EMULATOR_HOST=http://127.0.0.1:4443 pnpm --filter @crowi/api test -- --runInBand src/plugin/storage-gcs.emulator.test.ts
 *   docker compose --profile gcs-test stop crowi-test-gcs
 *
 * Not an ADC / real-IAM / `signBlob` oracle: fake-gcs-server accepts
 * anonymous unauthenticated requests and does not validate signed-URL
 * query params or enforce IAM. See
 * `docs/manual-verification/storage-gcs-provider.md` for what still needs a
 * real bucket and real credentials.
 *
 * The `Storage` client here is constructed with an explicit `apiEndpoint`
 * (the pattern fake-gcs-server's own docs/examples use —
 * https://github.com/fsouza/fake-gcs-server/tree/main/examples/node),
 * reading `STORAGE_EMULATOR_HOST` for the value itself, rather than
 * relying on the SDK's own `STORAGE_EMULATOR_HOST` auto-detection
 * (`new Storage()` with no options — what `buildState`'s ADC path uses in
 * production). That auto-detection sets `Storage#baseUrl` to the env var's
 * raw value with NO `/storage/v1` suffix, while the SDK's own non-resumable
 * upload path independently appends `/storage/v1` to `Storage#apiEndpoint`
 * regardless — two different base paths. Google's own storage-testbench
 * emulator apparently serves both shapes the same way (hence the SDK
 * defaulting to it), but fake-gcs-server mirrors real production GCS's
 * `/storage/v1` prefix everywhere, so the bare-env-var path breaks every
 * non-upload call (`get`/`delete`/`createBucket`) against it — verified
 * empirically: `put()` alone still succeeds (it happens to use
 * `Storage#apiEndpoint` + a hardcoded `/storage/v1` suffix either way), but
 * `get()`/`delete()` 404 on a real, present object because the request goes
 * to the wrong path. Passing `apiEndpoint` explicitly makes the SDK derive
 * both paths from the SAME base, matching fake-gcs-server's documented
 * client examples. `buildState`'s production ADC/inline client
 * construction is exercised separately by the mocked `storage-gcs.test.ts`
 * suite; this file's job is to prove the driver's actual wire operations
 * (`put`/`get`/`delete`, 404 classification, `runStorageCopy`) against a
 * real server, not to re-prove client construction.
 *
 * One more wrinkle, verified empirically: the SDK's `STORAGE_EMULATOR_HOST`
 * auto-detection does not defer to an explicit `apiEndpoint` of the SAME
 * value — `Storage`'s constructor computes `baseUrl = EMULATOR_HOST ||
 * \`${apiEndpoint}/storage/v1\`` and short-circuits on the env var being
 * truthy regardless of what `apiEndpoint` was requested — so as long as
 * `STORAGE_EMULATOR_HOST` is present in `process.env` at all (which the gate
 * command above sets, to gate `describeMaybe` itself), the broken bare-path
 * `baseUrl` still wins. This file captures the value once, then deletes it
 * from `process.env` immediately — every `Storage` client constructed below
 * uses the captured value as an explicit `apiEndpoint` instead.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import type { StateCell, StorageDriver } from '@crowi/plugin-api';
import { createGcsDriver, type GcsState, normalizePrefix } from '@crowi/plugin-storage-gcs';
import { createLocalDriver } from '@crowi/plugin-storage-local';
import { Storage } from '@google-cloud/storage';
import { crowi } from '../test/setup';
import { isMissingFileError } from '../util/file-uploader';
import { runStorageCopy } from '../util/storage-copy';
import { registerFakeDriver, unregisterFakeDriver, writeAt } from '../test/storage-driver-test-support';

const EMULATOR_HOST = process.env.STORAGE_EMULATOR_HOST;
// Must be genuinely absent (not merely `undefined`-valued) — the SDK checks
// `typeof process.env.STORAGE_EMULATOR_HOST === 'string'`, which a
// `process.env.STORAGE_EMULATOR_HOST = undefined` assignment would still
// satisfy (env vars coerce to the string `"undefined"`).
delete process.env.STORAGE_EMULATOR_HOST;
const describeMaybe = EMULATOR_HOST ? describe : describe.skip;

async function readAll(stream: Readable): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString('utf-8');
}

/**
 * This suite never reconfigures a driver mid-test — `StateCell` hot-reload
 * semantics (in-flight snapshot isolation across a `reconfigure()`) are
 * already covered end-to-end by the mocked `storage-gcs.test.ts` suite.
 * `withValue` here just awaits `fn` against the one fixed value.
 */
function makeFixedCell(value: GcsState): StateCell<GcsState> {
  return {
    get: () => value,
    withValue: (fn) => Promise.resolve(fn(value)),
    set: () => {
      throw new Error('reconfigure is not exercised by this suite — see storage-gcs.test.ts for StateCell hot-reload coverage');
    },
  };
}

function driverFor(storage: Storage, bucketName: string, prefix: string): StorageDriver {
  const state: GcsState = {
    storage,
    bucket: storage.bucket(bucketName),
    bucketName,
    prefix: normalizePrefix(prefix),
    credentialMode: 'adc',
  };
  return createGcsDriver(makeFixedCell(state));
}

describeMaybe('@crowi/plugin-storage-gcs against a real GCS-API-compatible server (fake-gcs-server)', () => {
  let storage: Storage;
  let bucketName: string;

  beforeAll(async () => {
    storage = new Storage({ apiEndpoint: EMULATOR_HOST, projectId: 'crowi-storage-gcs-emulator-test' });
    // Unique per run so a rerun against an already-up, still-populated
    // `crowi-test-gcs` container never hits a 409 "bucket already exists".
    bucketName = `crowi-test-gcs-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    await storage.createBucket(bucketName);
  });

  test('round-trips a Buffer through put / get', async () => {
    const driver = driverFor(storage, bucketName, '');
    const { key } = await driver.put('buffer.txt', Buffer.from('hello from a buffer', 'utf-8'), { contentType: 'text/plain' });
    expect(key).toBe('buffer.txt');
    const stream = await driver.get('buffer.txt');
    expect(await readAll(stream)).toBe('hello from a buffer');
  });

  test('round-trips a Readable through put / get', async () => {
    const driver = driverFor(storage, bucketName, '');
    await driver.put('readable.txt', Readable.from(['hello', '-', 'streamed']), { contentType: 'text/plain' });
    const stream = await driver.get('readable.txt');
    expect(await readAll(stream)).toBe('hello-streamed');
  });

  test('prefixes the physical object name while the logical key round-trips unchanged', async () => {
    const driver = driverFor(storage, bucketName, '/prod/wiki/');
    const { key } = await driver.put('attachment/p/k.png', Buffer.from('prefixed-bytes'), { contentType: 'application/octet-stream' });
    expect(key).toBe('attachment/p/k.png');

    // Physical placement: read the same bytes back through the raw client
    // at the normalized-prefix physical name, independent of the driver.
    const [raw] = await storage.bucket(bucketName).file('prod/wiki/attachment/p/k.png').download();
    expect(raw.toString('utf-8')).toBe('prefixed-bytes');

    // And the driver itself reads it back through the unprefixed logical key.
    const stream = await driver.get('attachment/p/k.png');
    expect(await readAll(stream)).toBe('prefixed-bytes');
  });

  test('delete is idempotent: succeeds for an existing object and no-ops for an absent one', async () => {
    const driver = driverFor(storage, bucketName, '');
    await driver.put('to-delete.txt', Buffer.from('bye'), { contentType: 'text/plain' });
    await expect(driver.delete('to-delete.txt')).resolves.toBeUndefined();
    // Second delete of the now-absent key must NOT reject — StorageDriver's idempotent-delete contract.
    await expect(driver.delete('to-delete.txt')).resolves.toBeUndefined();
  });

  test('get() on a missing object converts the real 404 into the code:"ENOENT" shape the unmodified core isMissingFileError classifies as missing', async () => {
    const driver = driverFor(storage, bucketName, '');
    let caught: unknown;
    try {
      await driver.get('never-existed.txt');
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(Error);
    expect((caught as { code?: unknown }).code).toBe('ENOENT');
    expect(isMissingFileError(caught)).toBe(true);
  });

  describe('local -> GCS storage copy (runStorageCopy is driver-neutral)', () => {
    const GCS_DRIVER_NAME = 'test-emulator-gcs';
    const LOCAL_DRIVER_NAME = 'test-emulator-local';
    let localRoot: string;

    beforeEach(async () => {
      localRoot = mkdtempSync(path.join(os.tmpdir(), 'storage-gcs-emulator-copy-src-'));
      registerFakeDriver(LOCAL_DRIVER_NAME, createLocalDriver({ rootDir: localRoot }));
      registerFakeDriver(GCS_DRIVER_NAME, driverFor(storage, bucketName, 'migrated'));
      await crowi.model('Attachment').deleteMany({}).exec();
    });

    afterEach(() => {
      unregisterFakeDriver(LOCAL_DRIVER_NAME);
      unregisterFakeDriver(GCS_DRIVER_NAME);
      rmSync(localRoot, { recursive: true, force: true });
    });

    test('copies attachment files from a local driver to the real GCS server', async () => {
      writeAt(localRoot, 'attachment/aaa/copied.txt', 'copied-to-gcs');
      await crowi.model('Attachment').create({ filePath: 'attachment/aaa/copied.txt', fileName: 'copied.txt', fileFormat: 'text/plain', fileSize: 13 });

      const summary = await runStorageCopy(crowi, { from: LOCAL_DRIVER_NAME, to: GCS_DRIVER_NAME, dryRun: false });

      expect(summary.ok).toBe(1);
      expect(summary.failed).toBe(0);

      const [raw] = await storage.bucket(bucketName).file('migrated/attachment/aaa/copied.txt').download();
      expect(raw.toString('utf-8')).toBe('copied-to-gcs');
    });
  });
});
