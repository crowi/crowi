/**
 * Integration tests for `@crowi/plugin-storage-local`'s driver. The
 * driver implementation lives in the package; we test it from here
 * because the package is a leaf workspace without its own jest setup.
 */
import { type ChildProcessByStdio, spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Readable as ReadableType } from 'node:stream';
import { Readable } from 'node:stream';
import plugin, { classifyLocalStorageError, createLocalDriver, probeStorageDriver } from '@crowi/plugin-storage-local';
import { CONFIG_VERIFICATION_KEY_PREFIX } from '@crowi/plugin-api';
import type { PluginConfigVerificationSnapshot } from '@crowi/plugin-api';
import { chunkOf } from './chunk-string';

/** Absolute path to the `tsx` CLI entry — already a devDependency of @crowi/api (same helper `collab/redis-smoke-harness-client.ts` uses to spawn a separate-process harness). */
function resolveTsxCli(): string {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  return require.resolve('tsx/cli');
}

/**
 * Spawn `storage-local-atomic-put-worker.ts` as a genuinely separate OS
 * process and resolve once it exits. Rejects (with stderr attached) on a
 * non-zero exit code.
 */
function spawnAtomicPutWorker(env: Record<string, string>): Promise<void> {
  return new Promise((resolve, reject) => {
    const workerPath = path.join(__dirname, 'storage-local-atomic-put-worker.ts');
    const proc: ChildProcessByStdio<null, ReadableType, ReadableType> = spawn(resolveTsxCli(), [workerPath], {
      env: { ...process.env, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stderrBuf = '';
    proc.stderr.on('data', (chunk: Buffer) => {
      stderrBuf += chunk.toString('utf8');
    });
    proc.once('exit', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`storage-local-atomic-put-worker exited with code ${code}: ${stderrBuf}`));
    });
    proc.once('error', reject);
  });
}

/** A Readable that yields `chunks` with a macrotask boundary between each — forces the event loop to interleave with a concurrent write. */
function slowReadable(chunks: string[]): Readable {
  let i = 0;
  return new Readable({
    async read() {
      if (i >= chunks.length) {
        this.push(null);
        return;
      }
      await new Promise((resolve) => setImmediate(resolve));
      this.push(chunks[i]);
      i += 1;
    },
  });
}

async function readAll(stream: Readable): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString('utf-8');
}

describe('@crowi/plugin-storage-local driver', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'crowi-storage-local-'));
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('round-trips a buffer through put / get', async () => {
    const driver = createLocalDriver({ rootDir: tmpDir });
    const { key } = await driver.put('a/b/hello.txt', Buffer.from('world', 'utf-8'), { contentType: 'text/plain' });
    expect(key).toBe('a/b/hello.txt');

    const stream = await driver.get('a/b/hello.txt');
    expect(await readAll(stream)).toBe('world');
  });

  it('round-trips a Readable through put / get', async () => {
    const driver = createLocalDriver({ rootDir: tmpDir });
    await driver.put('foo.txt', Readable.from(['hello', '-', 'streamed']), { contentType: 'text/plain' });
    const stream = await driver.get('foo.txt');
    expect(await readAll(stream)).toBe('hello-streamed');
  });

  it('creates intermediate directories on put', async () => {
    const driver = createLocalDriver({ rootDir: tmpDir });
    await driver.put('deep/nested/path/file.txt', Buffer.from('data'), { contentType: 'text/plain' });
    const stat = await fs.stat(path.join(tmpDir, 'deep', 'nested', 'path', 'file.txt'));
    expect(stat.isFile()).toBe(true);
  });

  it('throws ENOENT when reading a missing key', async () => {
    const driver = createLocalDriver({ rootDir: tmpDir });
    await expect(driver.get('nope.txt')).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('delete is idempotent', async () => {
    const driver = createLocalDriver({ rootDir: tmpDir });
    await driver.put('x.txt', Buffer.from('x'), { contentType: 'text/plain' });
    await driver.delete('x.txt');
    await driver.delete('x.txt'); // second delete: no-op
    await expect(driver.get('x.txt')).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('rejects keys that escape rootDir via ..', async () => {
    const driver = createLocalDriver({ rootDir: tmpDir });
    await expect(driver.put('../escape.txt', Buffer.from('x'), { contentType: 'text/plain' })).rejects.toThrow(/outside of rootDir/);
  });

  it('rejects absolute keys outside rootDir', async () => {
    const driver = createLocalDriver({ rootDir: tmpDir });
    await expect(driver.put('/etc/passwd', Buffer.from('x'), { contentType: 'text/plain' })).rejects.toThrow(/outside of rootDir/);
  });

  describe('listDerivativeObjects (feature-image-derivative-optimization §11 — `--gc` local enumeration)', () => {
    it('returns an empty array when nothing has been uploaded yet (no `attachment/` dir at all)', async () => {
      const driver = createLocalDriver({ rootDir: tmpDir });
      await expect(driver.listDerivativeObjects()).resolves.toEqual([]);
    });

    it('returns an empty array when `attachment/<page>/` exists but has no `derivatives/` subdir (never had a display derivative)', async () => {
      const driver = createLocalDriver({ rootDir: tmpDir });
      await driver.put('attachment/page1/original.jpg', Buffer.from('orig'), { contentType: 'image/jpeg' });
      await expect(driver.listDerivativeObjects()).resolves.toEqual([]);
    });

    it('enumerates every object under attachment/*/derivatives/*/* with its key, size, and mtime', async () => {
      const driver = createLocalDriver({ rootDir: tmpDir });
      await driver.put('attachment/page1/derivatives/att1/display-v1.jpg', Buffer.from('12345'), { contentType: 'image/jpeg' });
      await driver.put('attachment/page2/derivatives/att2/display-v1.webp', Buffer.from('1234567'), { contentType: 'image/webp' });
      // A sibling original (NOT under `derivatives/`) must be excluded.
      await driver.put('attachment/page1/original.jpg', Buffer.from('original bytes'), { contentType: 'image/jpeg' });

      const objects = await driver.listDerivativeObjects();
      expect(objects).toHaveLength(2);
      const byKey = new Map(objects.map((o) => [o.key, o]));
      expect(byKey.get('attachment/page1/derivatives/att1/display-v1.jpg')).toMatchObject({ size: 5 });
      expect(byKey.get('attachment/page2/derivatives/att2/display-v1.webp')).toMatchObject({ size: 7 });
      for (const obj of objects) {
        expect(typeof obj.mtimeMs).toBe('number');
        expect(obj.mtimeMs).toBeGreaterThan(0);
      }
    });
  });

  describe('atomic write (feature-image-derivative-optimization §7a)', () => {
    it('a concurrent get() during a slow put() to the SAME key never observes a torn/partial write', async () => {
      const driver = createLocalDriver({ rootDir: tmpDir });
      await driver.put('same-key.txt', Buffer.from('OLD-CONTENT'), { contentType: 'text/plain' });

      const putPromise = driver.put('same-key.txt', slowReadable(['NEW-', 'CONTENT-', 'REWRITTEN']), { contentType: 'text/plain' });

      // Give the slow write a couple of event-loop turns to start writing
      // its temp file, then read the target key WHILE the put is still
      // in flight. Because the write goes to a separate temp file first,
      // this must observe the complete OLD content, never a partial mix.
      await new Promise((resolve) => setImmediate(resolve));
      await new Promise((resolve) => setImmediate(resolve));
      const midFlightStream = await driver.get('same-key.txt');
      expect(await readAll(midFlightStream)).toBe('OLD-CONTENT');

      await putPromise;

      const finalStream = await driver.get('same-key.txt');
      expect(await readAll(finalStream)).toBe('NEW-CONTENT-REWRITTEN');

      // No leftover `.tmp` file in the directory after a successful put.
      const entries = await fs.readdir(tmpDir);
      expect(entries.some((name) => name.endsWith('.tmp'))).toBe(false);
    });

    it('two concurrent put() calls to the SAME key never interleave — the final content is fully one or the other', async () => {
      const driver = createLocalDriver({ rootDir: tmpDir });
      const contentA = 'A'.repeat(5000);
      const contentB = 'B'.repeat(5000);

      await Promise.all([
        driver.put('race-key.bin', slowReadable(chunkOf(contentA, 500)), { contentType: 'text/plain' }),
        driver.put('race-key.bin', slowReadable(chunkOf(contentB, 500)), { contentType: 'text/plain' }),
      ]);

      const finalStream = await driver.get('race-key.bin');
      const final = await readAll(finalStream);
      // Whichever put() rename()'d last wins outright — never a splice of both.
      expect(final === contentA || final === contentB).toBe(true);

      const entries = await fs.readdir(tmpDir);
      expect(entries.some((name) => name.endsWith('.tmp'))).toBe(false);
    });

    it('leaves no temp file behind when the source stream errors mid-write', async () => {
      const driver = createLocalDriver({ rootDir: tmpDir });
      const failingSource = new Readable({
        read() {
          this.push('partial-data');
          process.nextTick(() => this.destroy(new Error('simulated upload failure')));
        },
      });

      await expect(driver.put('will-fail.bin', failingSource, { contentType: 'application/octet-stream' })).rejects.toThrow(/simulated upload failure/);

      const entries = await fs.readdir(tmpDir);
      expect(entries.some((name) => name.endsWith('.tmp'))).toBe(false);
      // The target itself was never created either.
      await expect(driver.get('will-fail.bin')).rejects.toMatchObject({ code: 'ENOENT' });
    });
  });

  describe('atomic write across separate OS processes (feature-image-derivative-optimization §7a)', () => {
    it('a get() in THIS (separate) process never observes a torn/partial write while 2 OTHER processes race put() to the SAME key', async () => {
      const driver = createLocalDriver({ rootDir: tmpDir });
      const key = 'cross-process-race.bin';
      const oldContent = 'OLD-CONTENT-BEFORE-THE-RACE';
      await driver.put(key, Buffer.from(oldContent), { contentType: 'text/plain' });

      const contentA = 'A'.repeat(20000);
      const contentB = 'B'.repeat(20000);
      const baseEnv = {
        CROWI_STORAGE_LOCAL_ATOMIC_TEST_ROOT_DIR: tmpDir,
        CROWI_STORAGE_LOCAL_ATOMIC_TEST_KEY: key,
        CROWI_STORAGE_LOCAL_ATOMIC_TEST_CHUNK_SIZE: '500',
        CROWI_STORAGE_LOCAL_ATOMIC_TEST_CHUNK_DELAY_MS: '5',
      };

      // Two GENUINELY separate OS processes (different `process.pid`,
      // scheduled by the OS — not two Promises sharing this test's event
      // loop) racing to `put()` the SAME key.
      const workerA = spawnAtomicPutWorker({ ...baseEnv, CROWI_STORAGE_LOCAL_ATOMIC_TEST_CONTENT: contentA });
      const workerB = spawnAtomicPutWorker({ ...baseEnv, CROWI_STORAGE_LOCAL_ATOMIC_TEST_CONTENT: contentB });

      // This Jest test process is itself a THIRD, separate OS process from
      // both workers — poll get() on the raced key throughout their
      // lifetime and record every distinct value observed.
      const observed = new Set<string>();
      let polling = true;
      const pollLoop = (async () => {
        while (polling) {
          try {
            const stream = await driver.get(key);
            observed.add(await readAll(stream));
          } catch (err) {
            // A torn/partial read would surface as a value NOT in the
            // allow-list below, not as an exception — tolerate a rare
            // ENOENT window only (there shouldn't be one here since the key
            // pre-exists, but a flaky read must not fail the test for the
            // wrong reason).
            if ((err as NodeJS.ErrnoException)?.code !== 'ENOENT') throw err;
          }
          await new Promise((resolve) => setTimeout(resolve, 2));
        }
      })();

      await Promise.all([workerA, workerB]);
      polling = false;
      await pollLoop;

      const finalStream = await driver.get(key);
      const finalContent = await readAll(finalStream);
      observed.add(finalContent);

      // Every single read observed during the entire race — including ones
      // that landed while BOTH cross-process writes were in flight — must
      // be one of the 3 complete, non-torn values. A broken atomic-write
      // implementation would surface as some 4th value here (a
      // length/content splice of old+A, old+B, or A+B).
      for (const value of observed) {
        expect([oldContent, contentA, contentB]).toContain(value);
      }
      // The race actually resolved: the final content is fully one
      // worker's write, not the pre-race content (both workers wrote once
      // each and this key existed already, so a "no write happened" bug
      // would otherwise slip through the assertion above undetected).
      expect([contentA, contentB]).toContain(finalContent);

      // No leftover `.tmp` file from either cross-process writer.
      const entries = await fs.readdir(tmpDir);
      expect(entries.some((name) => name.endsWith('.tmp'))).toBe(false);
    }, 30000);
  });

  describe('verifyConfig (feature-plugin-config-live-verification, AC-5/AC-11)', () => {
    const fakeSnapshot = (rootDir: string): PluginConfigVerificationSnapshot => ({
      config: <T>() => ({ rootDir }) as T,
      dependencyConfig: () => {
        throw new Error('local storage has no dependencies');
      },
    });

    it('AC-5: round-trips a real put/get/delete under the reserved verification prefix, never under attachment/, and leaves nothing behind', async () => {
      const result = await plugin.verifyConfig!(fakeSnapshot(tmpDir), { timeoutMs: 10_000 });
      expect(result).toEqual({ status: 'ok' });

      // Cleanup is fire-and-forget (not awaited by verifyConfig itself) —
      // give it a turn to actually run before asserting on disk state.
      await new Promise((resolve) => setTimeout(resolve, 20));

      const verificationDir = path.join(tmpDir, CONFIG_VERIFICATION_KEY_PREFIX.replace(/\/$/, ''));
      await expect(fs.readdir(verificationDir)).resolves.toEqual([]);
      await expect(fs.access(path.join(tmpDir, 'attachment'))).rejects.toMatchObject({ code: 'ENOENT' });
    });

    it('a put failure is classified and no cleanup is attempted (nothing was written)', async () => {
      const err = Object.assign(new Error('nope'), { code: 'EACCES' });
      const putSpy = jest.fn(async () => {
        throw err;
      });
      const deleteSpy = jest.fn(async () => {});
      const result = await probeStorageDriver({ put: putSpy, get: jest.fn(), delete: deleteSpy }, classifyLocalStorageError);

      expect(result).toEqual({ status: 'failed', reason: 'write-denied' });
      expect(deleteSpy).not.toHaveBeenCalled();
    });

    it('a get failure after a successful put is classified, and the independent cleanup delete still runs', async () => {
      const err = Object.assign(new Error('gone'), { code: 'ENOENT' });
      const putSpy = jest.fn(async (key: string) => ({ key }));
      const getSpy = jest.fn(async () => {
        throw err;
      });
      const deleteSpy = jest.fn(async () => {});
      const result = await probeStorageDriver({ put: putSpy, get: getSpy, delete: deleteSpy }, classifyLocalStorageError);

      expect(result).toEqual({ status: 'failed', reason: 'resource-missing' });
      expect(deleteSpy).toHaveBeenCalledTimes(1);
    });

    it('a payload mismatch on read-back is reported as unknown (not a classified driver exception), and cleanup still runs', async () => {
      const putSpy = jest.fn(async (key: string) => ({ key }));
      const getSpy = jest.fn(async () => Readable.from([Buffer.from('not-the-payload')]));
      const deleteSpy = jest.fn(async () => {});
      const result = await probeStorageDriver({ put: putSpy, get: getSpy, delete: deleteSpy }, classifyLocalStorageError);

      expect(result).toEqual({ status: 'failed', reason: 'unknown' });
      expect(deleteSpy).toHaveBeenCalledTimes(1);
    });

    it('a put() that reports storing under a different key than requested is reported as unknown, even though the payload round-trips correctly', async () => {
      let written: Buffer | undefined;
      const putSpy = jest.fn(async (_key: string, body: unknown) => {
        written = body as Buffer;
        return { key: 'some-other-key' };
      });
      const getSpy = jest.fn(async () => Readable.from([written as Buffer]));
      const deleteSpy = jest.fn(async () => {});
      const result = await probeStorageDriver({ put: putSpy, get: getSpy, delete: deleteSpy }, classifyLocalStorageError);

      expect(result).toEqual({ status: 'failed', reason: 'unknown' });
      expect(deleteSpy).toHaveBeenCalledTimes(1);
    });

    it('AC-11: even when get() only settles after a short delay, cleanup waits for it (put -> get -> delete ordering preserved in the common case)', async () => {
      const putSpy = jest.fn(async (key: string) => ({ key }));
      const deleteSpy = jest.fn(async () => {});
      let releaseGet: (() => void) | undefined;
      const gate = new Promise<void>((resolve) => {
        releaseGet = resolve;
      });
      const getSpy = jest.fn(async () => {
        await gate;
        throw Object.assign(new Error('gone'), { code: 'ENOENT' });
      });

      // A generous cleanup budget (well beyond how long this test holds
      // `get()` gated) — cleanup should still be waiting on `get()`, not
      // racing ahead of it, for a delay this far under the budget.
      const resultPromise = probeStorageDriver({ put: putSpy, get: getSpy, delete: deleteSpy }, classifyLocalStorageError, 5_000);

      await Promise.resolve();
      await Promise.resolve();
      expect(deleteSpy).not.toHaveBeenCalled();

      releaseGet?.();
      const result = await resultPromise;

      expect(result).toEqual({ status: 'failed', reason: 'resource-missing' });
      expect(deleteSpy).toHaveBeenCalledTimes(1);
    });

    it('AC-11: a rejecting cleanup delete does not alter a successful verdict', async () => {
      // `probeStorageDriver` derives the expected payload internally
      // (random 32 bytes), so drive `getSpy` off whatever `putSpy` actually
      // received rather than a fixed literal.
      let written: Buffer | undefined;
      const putSpy = jest.fn(async (key: string, body: unknown) => {
        written = body as Buffer;
        return { key };
      });
      const getSpy = jest.fn(async () => Readable.from([written as Buffer]));
      const deleteSpy = jest.fn(async () => {
        throw Object.assign(new Error('cleanup delete failed'), { code: 'EACCES' });
      });
      const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});

      const result = await probeStorageDriver({ put: putSpy, get: getSpy, delete: deleteSpy }, classifyLocalStorageError);
      expect(result).toEqual({ status: 'ok' });

      // The cleanup delete is fire-and-forget — give its rejection a turn
      // to be caught before asserting nothing propagated out of the probe.
      await new Promise((resolve) => setImmediate(resolve));
      expect(deleteSpy).toHaveBeenCalledTimes(1);
      warnSpy.mockRestore();
    });

    it('AC-11: a rejecting cleanup delete does not alter an already-failed verdict', async () => {
      const putSpy = jest.fn(async (key: string) => ({ key }));
      const getSpy = jest.fn(async () => {
        throw Object.assign(new Error('gone'), { code: 'ENOENT' });
      });
      const deleteSpy = jest.fn(async () => {
        throw Object.assign(new Error('cleanup delete failed too'), { code: 'EACCES' });
      });
      const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});

      const result = await probeStorageDriver({ put: putSpy, get: getSpy, delete: deleteSpy }, classifyLocalStorageError);

      // `get()`'s own ENOENT decides the verdict — the ALSO-rejecting
      // cleanup delete must not downgrade/override it to `unknown` or
      // anything else.
      expect(result).toEqual({ status: 'failed', reason: 'resource-missing' });
      await new Promise((resolve) => setImmediate(resolve));
      expect(deleteSpy).toHaveBeenCalledTimes(1);
      warnSpy.mockRestore();
    });

    it('the happy path calls delete exactly once, after a successful matching read-back', async () => {
      let written: Buffer | undefined;
      const putSpy = jest.fn(async (key: string, body: unknown) => {
        written = body as Buffer;
        return { key };
      });
      const getSpy = jest.fn(async () => Readable.from([written as Buffer]));
      const deleteSpy = jest.fn(async () => {});

      const result = await probeStorageDriver({ put: putSpy, get: getSpy, delete: deleteSpy }, classifyLocalStorageError);

      expect(result).toEqual({ status: 'ok' });
      expect(putSpy).toHaveBeenCalledTimes(1);
      expect(getSpy).toHaveBeenCalledTimes(1);
      expect(deleteSpy).toHaveBeenCalledTimes(1);
    });

    it('uses a fresh, reserved-prefix key on every call — two probes never collide', async () => {
      const seenKeys: string[] = [];
      const bufByKey = new Map<string, Buffer>();
      const putSpy = jest.fn(async (key: string, body: unknown) => {
        seenKeys.push(key);
        bufByKey.set(key, body as Buffer);
        return { key };
      });
      const getSpy = jest.fn(async (key: string) => Readable.from([bufByKey.get(key) as Buffer]));
      const deleteSpy = jest.fn(async () => {});

      await probeStorageDriver({ put: putSpy, get: getSpy, delete: deleteSpy }, classifyLocalStorageError);
      await probeStorageDriver({ put: putSpy, get: getSpy, delete: deleteSpy }, classifyLocalStorageError);

      expect(seenKeys).toHaveLength(2);
      expect(seenKeys[0]).not.toBe(seenKeys[1]);
      for (const key of seenKeys) expect(key.startsWith(CONFIG_VERIFICATION_KEY_PREFIX)).toBe(true);
    });

    it('AC-11: cleanup delete fires within its own budget even when get() is still gated well past it — the delete is NOT sequenced strictly after get() settling', async () => {
      const putSpy = jest.fn(async (key: string) => ({ key }));
      const deleteSpy = jest.fn(async () => {});
      let releaseGet: (() => void) | undefined;
      const gate = new Promise<void>((resolve) => {
        releaseGet = resolve;
      });
      const getSpy = jest.fn(async () => {
        // Simulates a `get()` far slower than the caller (the manager's
        // 10s hook race) would ever wait for — but not aborted (§3): the
        // underlying probe keeps running and eventually settles.
        await gate;
        return Readable.from([Buffer.from('irrelevant-by-then')]);
      });

      // A short cleanup budget so the test doesn't need real multi-second
      // waits or fake timers (which don't mix well with async-iterable
      // stream reads).
      const resultPromise = probeStorageDriver({ put: putSpy, get: getSpy, delete: deleteSpy }, classifyLocalStorageError, 30);

      // `get()` is still gated (never released yet) when the cleanup
      // budget elapses — delete must fire anyway.
      await new Promise((resolve) => setTimeout(resolve, 80));
      expect(deleteSpy).toHaveBeenCalledTimes(1);

      releaseGet?.();
      await resultPromise;
    });

    describe('classifyLocalStorageError', () => {
      it.each([
        ['ENOENT', 'resource-missing'],
        ['EACCES', 'write-denied'],
        ['EPERM', 'write-denied'],
        ['EROFS', 'write-denied'],
        ['ECONNREFUSED', 'unknown'],
      ] as const)('maps %s to %s', (code, expected) => {
        const err = Object.assign(new Error('boom'), { code });
        expect(classifyLocalStorageError(err)).toBe(expected);
      });

      it('maps a non-errno error (no .code) to unknown', () => {
        expect(classifyLocalStorageError(new Error('boom'))).toBe('unknown');
      });
    });
  });
});
