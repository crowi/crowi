/**
 * feature-image-derivative-optimization §7a — standalone worker process for
 * `storage-local.test.ts`'s cross-process atomic-write test. Run via `tsx`
 * (the same pattern `collab/redis-smoke-harness-client.ts` uses to spawn a
 * separate OS process for a multi-process scenario), so the "同じキーへの
 * 並行 put(2プロセス以上)" case the spec requires is exercised with a
 * GENUINE separate `process.pid` — same-process concurrent Promises would
 * share a single event loop and trivially serialize on the same
 * `fs.rename()` call, proving nothing about cross-process atomicity.
 *
 * Control protocol: all config arrives via env vars (spawn is cheap to
 * reconfigure per test run; there is nothing to coordinate on stdin before
 * starting). Writes the target key with a slow, chunked `Readable` (a delay
 * between chunks) so the write window is wide enough for a concurrent
 * reader — including the Jest parent process, itself a separate OS process
 * from this one — to land mid-flight if atomicity were broken. Emits
 * exactly one JSON line on stdout on success (`{"ok":true,"pid":<number>}`)
 * and exits 0; on failure, exits 1 after logging to stderr.
 */
import { Readable } from 'node:stream';
import { createLocalDriver } from '@crowi/plugin-storage-local';
import { chunkOf } from './chunk-string';

function slowReadable(chunks: string[], delayMs: number): Readable {
  let i = 0;
  return new Readable({
    async read() {
      if (i >= chunks.length) {
        this.push(null);
        return;
      }
      if (delayMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, delayMs));
      }
      this.push(chunks[i]);
      i += 1;
    },
  });
}

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (value === undefined) {
    throw new Error(`storage-local-atomic-put-worker: missing required env var ${name}`);
  }
  return value;
}

async function main(): Promise<void> {
  const rootDir = requiredEnv('CROWI_STORAGE_LOCAL_ATOMIC_TEST_ROOT_DIR');
  const key = requiredEnv('CROWI_STORAGE_LOCAL_ATOMIC_TEST_KEY');
  const content = requiredEnv('CROWI_STORAGE_LOCAL_ATOMIC_TEST_CONTENT');
  const chunkSize = Number.parseInt(process.env.CROWI_STORAGE_LOCAL_ATOMIC_TEST_CHUNK_SIZE ?? '500', 10);
  const chunkDelayMs = Number.parseInt(process.env.CROWI_STORAGE_LOCAL_ATOMIC_TEST_CHUNK_DELAY_MS ?? '5', 10);

  const driver = createLocalDriver({ rootDir });
  await driver.put(key, slowReadable(chunkOf(content, chunkSize), chunkDelayMs), { contentType: 'text/plain' });

  process.stdout.write(`${JSON.stringify({ ok: true, pid: process.pid })}\n`);
}

main().catch((err: unknown) => {
  process.stderr.write(`storage-local-atomic-put-worker fatal: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`);
  process.exit(1);
});
