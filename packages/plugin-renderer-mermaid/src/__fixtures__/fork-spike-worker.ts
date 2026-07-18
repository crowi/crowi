/**
 * Jest-side helper: forks spike-worker.ts and exposes a promise-based
 * request/response API over the id-correlated IPC protocol
 * (spike-protocol.ts). Used by render-engine.spike.test.ts and
 * render-engine.no-network.spike.test.ts. This file itself is a plain
 * `.ts` module compiled normally by ts-jest — it never imports `mermaid`
 * or `jsdom` directly, only `node:child_process`/`node:path`, so it needs
 * none of the ESM workarounds the worker itself does.
 */

import { type ChildProcess, fork } from 'node:child_process';
import path from 'node:path';
import type { RenderRequestMessage, RenderResponseMessage, WorkerOutboundMessage } from './spike-protocol';

export interface SpikeWorker {
  readonly child: ChildProcess;
  render(request: Omit<RenderRequestMessage, 'type'>): Promise<RenderResponseMessage>;
  kill(signal?: NodeJS.Signals): void;
}

const WORKER_PATH = path.join(__dirname, 'spike-worker.ts');

/**
 * Forks the worker and resolves once it reports `ready`. Node's own type
 * stripping loads `spike-worker.ts` directly — no build step, matching
 * §8's "no tsup.config.ts / build script in Phase 0" note (the worker is
 * only ever run this way in Phase 0; Phase 1 forks a *built* `.js` file
 * per §10, which is a separate, tsup-generated artifact).
 *
 * `--no-warnings` suppresses Node's `[MODULE_TYPELESS_PACKAGE_JSON]`
 * advisory that `spike-worker.ts` (and the sibling `.ts` modules it
 * imports) trigger by using `import`/`export` syntax with no
 * `package.json: "type"` declared (see spike-worker.ts's own doc comment)
 * — a cosmetic stderr warning, not a behavior difference.
 */
export function forkSpikeWorker(): Promise<SpikeWorker> {
  return new Promise((resolve, reject) => {
    const child = fork(WORKER_PATH, {
      execArgv: ['--no-warnings'],
      stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
    });

    const pending = new Map<number, { resolve: (msg: RenderResponseMessage) => void; reject: (err: Error) => void }>();

    const onReadyOrResult = (msg: WorkerOutboundMessage) => {
      if (msg.type === 'ready') {
        child.off('message', onReadyOrResult);
        child.on('message', (m: WorkerOutboundMessage) => {
          if (m.type !== 'render-result') return;
          const waiter = pending.get(m.id);
          if (!waiter) return;
          pending.delete(m.id);
          waiter.resolve(m);
        });
        resolve({
          child,
          render(request) {
            return new Promise((res, rej) => {
              pending.set(request.id, { resolve: res, reject: rej });
              child.send({ type: 'render', ...request } satisfies RenderRequestMessage);
            });
          },
          kill(signal) {
            child.kill(signal);
          },
        });
        return;
      }
    };
    child.on('message', onReadyOrResult);

    child.on('error', (err) => reject(err));
    child.once('exit', (code) => {
      if (code !== 0 && code !== null) {
        reject(new Error(`spike-worker exited early with code ${code}`));
      }
    });
  });
}
