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
import { createLocalDriver } from '@crowi/plugin-storage-local';
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
});
