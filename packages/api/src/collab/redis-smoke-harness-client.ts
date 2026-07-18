/**
 * feature-redis-8-upgrade Phase 2 — parent-process (Jest) client for
 * `redis-smoke-harness.ts`. Spawns/stops one harness `tsx` child process and
 * speaks its single-JSON-line ready-notification protocol (see that file's
 * doc comment). Shared by two smoke test files that both need it:
 *   - `extension-redis.smoke.test.ts` (consumer #1): spawns TWO harnesses
 *     against the shared plaintext target and drives real Y.Doc sync +
 *     Awareness propagation between them.
 *   - `crowi/index.smoke.test.ts` (consumer #8, boot/TLS sub-scenario):
 *     spawns ONE harness against the `rediss://` fixture and treats it
 *     reaching "ready" as proof the collab-side ioredis client completed a
 *     real TLS handshake (the harness itself forces a connect+PING on the
 *     extension's `pub` client before signaling ready).
 *
 * Extracted here (rather than duplicated in both smoke test files) once a
 * second consumer needed the exact same spawn/ready-wait/graceful-stop
 * logic.
 */
import { type ChildProcessByStdio, spawn } from 'node:child_process';
import path from 'node:path';
import readline from 'node:readline';
import type { Readable } from 'node:stream';

export interface RedisSmokeHarness {
  // `stdio: ['ignore', 'pipe', 'pipe']` below means stdin is null (not a
  // `Writable`, which `ChildProcessWithoutNullStreams` would require) —
  // this is the type `spawn()` actually returns for that exact stdio shape.
  proc: ChildProcessByStdio<null, Readable, Readable>;
  port: number;
  label: string;
}

/** Absolute path to the `tsx` CLI entry — already a devDependency of @crowi/api. */
function resolveTsxCli(): string {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  return require.resolve('tsx/cli');
}

/**
 * Spawn one `redis-smoke-harness.ts` process and wait for its single
 * ready-notification JSON line on stdout (see that file's doc comment for
 * the protocol). Rejects if the process exits or times out before
 * signaling ready. `extraEnv` is merged on top of the parent's own env
 * (e.g. `REDIS_REJECT_UNAUTHORIZED: '0'` for the self-signed TLS fixture).
 */
export function spawnRedisSmokeHarness(label: string, redisUrl: string, extraEnv?: Record<string, string>): Promise<RedisSmokeHarness> {
  return new Promise((resolve, reject) => {
    const harnessPath = path.join(__dirname, 'redis-smoke-harness.ts');
    const proc = spawn(resolveTsxCli(), [harnessPath], {
      env: { ...process.env, CROWI_REDIS_SMOKE_REDIS_URL: redisUrl, CROWI_REDIS_SMOKE_LABEL: label, ...extraEnv },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let settled = false;
    let stderrBuf = '';
    proc.stderr.on('data', (chunk: Buffer) => {
      stderrBuf += chunk.toString('utf8');
    });

    const rl = readline.createInterface({ input: proc.stdout });
    const onLine = (line: string): void => {
      if (settled) return;
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        return; // not the ready line — ignore (e.g. a stray log)
      }
      if (parsed && typeof parsed === 'object' && (parsed as { ready?: unknown }).ready === true) {
        settled = true;
        rl.close();
        resolve({ proc, port: (parsed as { port: number }).port, label });
      }
    };
    rl.on('line', onLine);

    proc.once('exit', (code) => {
      if (!settled) {
        settled = true;
        reject(new Error(`redis-smoke-harness (${label}) exited before signaling ready (code=${code}): ${stderrBuf}`));
      }
    });
    proc.once('error', (err) => {
      if (!settled) {
        settled = true;
        reject(err);
      }
    });
    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        // Ready-signal timeout with the child still alive (unlike the
        // `exit` branch above, where the process is already gone) — kill it
        // so a slow-to-signal harness never lingers past this test.
        try {
          proc.kill('SIGKILL');
        } catch {
          // ignore
        }
        reject(new Error(`redis-smoke-harness (${label}) did not signal ready within 20s. stderr: ${stderrBuf}`));
      }
    }, 20000);
    proc.once('exit', () => clearTimeout(timer));
  });
}

/** Graceful SIGTERM, falling back to SIGKILL if the process doesn't exit within the grace window. */
export function stopRedisSmokeHarness(harness: RedisSmokeHarness): Promise<void> {
  return new Promise((resolve) => {
    let resolved = false;
    const finish = (): void => {
      if (resolved) return;
      resolved = true;
      resolve();
    };
    const timer = setTimeout(() => {
      try {
        harness.proc.kill('SIGKILL');
      } catch {
        // ignore
      }
      finish();
    }, 5000);
    harness.proc.once('exit', () => {
      clearTimeout(timer);
      finish();
    });
    try {
      harness.proc.kill('SIGTERM');
    } catch {
      clearTimeout(timer);
      finish();
    }
  });
}
