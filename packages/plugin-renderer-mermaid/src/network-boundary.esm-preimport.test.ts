/**
 * Codex round 1 (feature-plugin-renderer-mermaid Phase 1 review) flagged
 * that `network-boundary.test.ts` cannot observe the real risk it claims
 * to close: ts-jest transpiles that test file's `import * as net from
 * 'node:net'` down to a plain CJS `require()`, so it can never exercise
 * the genuine-ESM-named-import staleness gap the production worker is
 * actually exposed to (see `network-boundary.ts`'s header comment on
 * `syncBuiltinESMExports()`).
 *
 * This suite closes that gap for real: it forks
 * `__fixtures__/esm-preimport-boundary-worker.ts` as an actual child
 * process running genuine ESM (not ts-jest's CJS transform), where a
 * `node:dns` named import is resolved BEFORE the boundary installs —
 * reproducing `render-worker.ts`'s real import order hazard (`dom-env.ts`'s
 * `jsdom` import happens before `network-boundary.ts` installs) — and
 * asserts the pre-imported binding is blocked anyway. See the fixture's own
 * doc comment for why `dns.lookup` (not `net.connect`/`http.request`) is
 * the vector that actually discriminates a working
 * `syncBuiltinESMExports()` call from a regressed/missing one.
 */
import { type ChildProcess, fork } from 'node:child_process';
import path from 'node:path';

interface ProbeResultMessage {
  type: 'probe-result';
  dnsLookupBlocked: boolean;
}

const WORKER_PATH = path.join(__dirname, '__fixtures__', 'esm-preimport-boundary-worker.ts');

function forkAndProbe(): Promise<ProbeResultMessage> {
  return new Promise((resolve, reject) => {
    const child: ChildProcess = fork(WORKER_PATH, {
      execArgv: ['--no-warnings'],
      stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
    });

    child.once('error', reject);
    child.once('exit', (code) => {
      if (code !== 0 && code !== null) reject(new Error(`esm-preimport-boundary-worker exited early with code ${code}`));
    });

    const onMessage = (msg: { type: string }) => {
      if (msg.type === 'ready') {
        child.send({ type: 'probe' });
        return;
      }
      if (msg.type === 'probe-result') {
        child.off('message', onMessage);
        child.kill('SIGKILL');
        resolve(msg as ProbeResultMessage);
      }
    };
    child.on('message', onMessage);
  });
}

describe('installDenyByDefaultNetworkBoundary — ESM named-import staleness (real forked worker)', () => {
  it('blocks a node:dns named import resolved before the boundary installs', async () => {
    const result = await forkAndProbe();
    expect(result.dnsLookupBlocked).toBe(true);
  }, 15_000);
});
