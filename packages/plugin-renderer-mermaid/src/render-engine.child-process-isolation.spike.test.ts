/**
 * Phase 0 gate C — child-process isolation
 * (.feature-state/specs/feature-plugin-renderer-mermaid.md §8 C), plus
 * gate D — native-addon dependency audit (§8 D), recorded in this file
 * because both bear on the same question: can Phase 1's worker-pool /
 * deny-by-default boundary (§6, §10) actually hold?
 *
 * Gate C forks the same __fixtures__/spike-worker.ts used by gates A/B
 * directly with `node:child_process.fork()` (not through
 * fork-spike-worker.ts's ready-then-reuse helper — each test here forks
 * its own short-lived worker, since the whole point is to observe
 * fork/kill lifecycle behavior, not to reuse a long-lived one) and
 * checks the 3 conditions §8 C requires:
 *   5. Rendering in the child does not block the parent's event loop.
 *   6. `child.kill('SIGKILL')` mid-render leaves no zombie / unreleased
 *      handle in the parent.
 *   7. 10x spawn/render/kill cycles do not monotonically grow the
 *      parent's resource count or memory.
 *
 * C-6 and C-7 both need the SIGKILL to land while `mermaid.render()` is
 * genuinely still executing, not merely "requested" — they use
 * __fixtures__/spike-protocol.ts's `render-started` IPC message (sent by
 * the worker right *after* it invokes `mermaid.render()`, so the call has
 * unconditionally already begun by the time the parent can observe the
 * message — see spike-worker.ts's doc comment) combined with
 * __fixtures__/large-flowchart.ts's deliberately slow (~700-900ms) source,
 * so a kill sent within single-digit milliseconds of `render-started`
 * lands confidently mid-execution: the render takes two to three orders
 * of magnitude longer than the IPC round trip + kill dispatch. An earlier
 * version of this test sent `render-started` *before* calling
 * `mermaid.render()`, with an artificial `setImmediate` gap in between —
 * a kill landing in that gap would satisfy "no render-result received"
 * without render() ever having been invoked at all, which does not prove
 * a mid-render kill.
 */

import { type ChildProcess, fork } from 'node:child_process';
import { type Dirent, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import v8 from 'node:v8';
import vm from 'node:vm';
import { LARGE_FLOWCHART_SOURCE } from './__fixtures__/large-flowchart';
import type { ReadyMessage, RenderRequestMessage, RenderResponseMessage, RenderStartedMessage } from './__fixtures__/spike-protocol';

const WORKER_PATH = path.join(__dirname, '__fixtures__/spike-worker.ts');

type WorkerMessage = ReadyMessage | RenderStartedMessage | RenderResponseMessage;

function forkWorker(): ChildProcess {
  return fork(WORKER_PATH, {
    execArgv: ['--no-warnings'],
    stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
  });
}

// `spike-worker.ts` sends `ready` only after a genuinely expensive cold
// start (jsdom setup, network instrumentation, importing the real
// `mermaid` dependency graph, `initialize()`) — deliberately real, not the
// deterministic fixture `render-engine.test.ts` uses elsewhere in this
// package, because Gate C's whole point is to observe fork/kill lifecycle
// behavior against a genuine render (see this file's top doc comment).
// Under CI CPU contention (turbo running multiple packages' test tasks
// concurrently, `@crowi/api`'s own multi-worker jest suite competing for
// the same cores) that cold start can legitimately take longer than a
// budget sized for an unloaded machine — root-caused via Codex sol,
// `.reviews/codex-runs/investigate-mermaid-spike-test-timeout/out.json`
// (high confidence; CI run 29717641489 timed out here with every other
// test file in the package, and the rest of the suite, passing). This
// bounds a genuine startup hang (not a mid-render hang — see waitForReady's
// own SIGKILL below) at a generous fixed budget per fork, independent of
// the enclosing Jest test's own timeout, and rejects loudly (with the
// child reaped) instead of leaving Jest's own timeout as the only signal.
const WORKER_READY_TIMEOUT_MS = 30_000;

function waitForReady(child: ChildProcess): Promise<void> {
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      child.off('message', onMessage);
      child.off('error', onError);
      child.off('exit', onExit);
      clearTimeout(timer);
    };
    const onMessage = (msg: WorkerMessage) => {
      if (msg.type === 'ready') {
        cleanup();
        resolve();
      }
    };
    const onError = (err: Error) => {
      cleanup();
      reject(err);
    };
    const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
      cleanup();
      reject(new Error(`worker exited before sending 'ready' (code=${code}, signal=${signal})`));
    };
    const timer = setTimeout(() => {
      cleanup();
      child.kill('SIGKILL');
      reject(new Error(`worker did not send 'ready' within ${WORKER_READY_TIMEOUT_MS}ms`));
    }, WORKER_READY_TIMEOUT_MS);
    child.on('message', onMessage);
    child.once('error', onError);
    child.once('exit', onExit);
  });
}

/**
 * Resolves once the worker confirms (via IPC, not a timer) that it has
 * already invoked `mermaid.render()` for the given request id. See the
 * file header and spike-protocol.ts's `RenderStartedMessage` for why this
 * replaces an artificial pre-render delay.
 */
function waitForRenderStarted(child: ChildProcess, id: number): Promise<void> {
  return new Promise((resolve) => {
    const onMessage = (msg: WorkerMessage) => {
      if (msg.type === 'render-started' && msg.id === id) {
        child.off('message', onMessage);
        resolve();
      }
    };
    child.on('message', onMessage);
  });
}

/**
 * Forces a full V8 GC without needing the process to be started with
 * `--expose-gc` (jest workers aren't) — `v8.setFlagsFromString` toggles the
 * flag at runtime just long enough for `vm.runInNewContext('gc')` to
 * resolve a callable `gc`, then toggles it back off. Used to make
 * `process.memoryUsage().heapUsed` samples in C-7 meaningful (otherwise
 * GC timing is nondeterministic and the series would be dominated by
 * collection-scheduling noise rather than actual retained memory).
 */
function forceGc(): void {
  v8.setFlagsFromString('--expose-gc');
  const gc = vm.runInNewContext('gc') as () => void;
  v8.setFlagsFromString('--no-expose-gc');
  gc();
}

/**
 * The textbook signature of a per-cycle resource/memory leak: the sampled
 * series grows at *every single* step. A healthy (flat, or fluctuating but
 * bounded) series is not this. Checking it directly — rather than only
 * comparing the final sample to the run's own peak, which any bounded
 * series trivially satisfies — is what makes the C-7 assertions
 * non-tautological.
 */
function isStrictlyIncreasing(samples: readonly number[]): boolean {
  return samples.every((v, i) => i === 0 || v > samples[i - 1]);
}

describe('Phase 0 gate C: child-process isolation', () => {
  it(
    'C-5: rendering in the child does not block the parent event loop',
    async () => {
      const child = forkWorker();
      try {
        await waitForReady(child);

        let parentTicks = 0;
        const timer = setInterval(() => {
          parentTicks++;
        }, 10);

        const resultPromise = new Promise<RenderResponseMessage>((resolve) => {
          child.on('message', (msg: WorkerMessage) => {
            if (msg.type === 'render-result') resolve(msg);
          });
        });
        const request: RenderRequestMessage = { type: 'render', id: 1, source: LARGE_FLOWCHART_SOURCE };
        child.send(request);
        const result = await resultPromise;
        clearInterval(timer);

        expect(result.ok).toBe(true);
        // The parent's own timer must have ticked repeatedly *during* the
        // several hundred ms the child spent rendering the large fixture —
        // if the child render blocked the parent (e.g. because it wasn't
        // actually a separate process), this would be 0 or close to it.
        expect(parentTicks).toBeGreaterThan(20);
      } finally {
        child.kill();
      }
      // WORKER_READY_TIMEOUT_MS (the worker's own cold-start budget) + slack
      // for the render itself — see WORKER_READY_TIMEOUT_MS's doc comment.
    },
    WORKER_READY_TIMEOUT_MS + 15_000,
  );

  it(
    'C-6: SIGKILL mid-render leaves no zombie or unreleased handle',
    async () => {
      const child = forkWorker();
      await waitForReady(child);
      const pid = child.pid;
      expect(pid).toBeDefined();

      let renderCompletedBeforeKill = false;
      child.on('message', (msg: WorkerMessage) => {
        if (msg.type === 'render-result') renderCompletedBeforeKill = true;
      });

      const exitPromise = new Promise<void>((resolve) => {
        child.once('exit', () => resolve());
      });

      const request: RenderRequestMessage = { type: 'render', id: 1, source: LARGE_FLOWCHART_SOURCE };
      child.send(request);
      // Wait for the worker's own confirmation that mermaid.render() has
      // already been invoked (see waitForRenderStarted's doc comment) —
      // LARGE_FLOWCHART_SOURCE takes ~700-900ms to render, so the SIGKILL
      // below (sent within single-digit ms of that confirmation) lands
      // confidently mid-execution.
      await waitForRenderStarted(child, request.id);
      child.kill('SIGKILL');
      await exitPromise;

      // Never received a completed render before the kill — confirms this
      // was genuinely mid-render, not "already finished by the time we
      // killed it".
      expect(renderCompletedBeforeKill).toBe(false);

      // A killed process is briefly a zombie until the parent reaps it;
      // Node's ChildProcess machinery does that reap as part of emitting
      // `exit`, so by the time `exitPromise` resolves, the PID should no
      // longer be signalable.
      expect(() => process.kill(pid as number, 0)).toThrow();
      // See WORKER_READY_TIMEOUT_MS's doc comment.
    },
    WORKER_READY_TIMEOUT_MS + 15_000,
  );

  it(
    'C-7: 10x spawn/render/kill cycles do not monotonically grow parent resources or memory',
    async () => {
      async function spawnRenderKillCycle(): Promise<void> {
        const child = forkWorker();
        await waitForReady(child);
        const exitPromise = new Promise<void>((resolve) => {
          child.once('exit', () => resolve());
        });
        const request: RenderRequestMessage = { type: 'render', id: 1, source: LARGE_FLOWCHART_SOURCE };
        child.send(request);
        // Same "genuinely mid-render, not just requested" handshake as C-6 —
        // each cycle kills a real in-flight render, per §8 C-7's "生成→レン
        // ダリング開始→kill()".
        await waitForRenderStarted(child, request.id);
        child.kill('SIGKILL');
        await exitPromise;
      }

      // Sample a *pre-cycle* baseline before any spawn/render/kill cycle
      // runs — a reviewer fix: an earlier version of this test began
      // sampling only after the first cycle completed, so a leak incurred
      // by that very first cycle was invisible to every comparison below
      // (both the strictly-increasing check and the final-vs-first bound
      // implicitly treated the post-cycle-1 sample as if it were the
      // starting point).
      forceGc();
      const baselineResourceCount = process.getActiveResourcesInfo().length;
      const baselineHeapUsed = process.memoryUsage().heapUsed;

      const resourceCounts: number[] = [];
      const heapUsedBytes: number[] = [];
      for (let i = 0; i < 10; i++) {
        await spawnRenderKillCycle();
        // Let the event loop settle (socket/pipe teardown callbacks) before
        // sampling, same as a real leak-detector would.
        await new Promise((resolve) => setTimeout(resolve, 20));
        forceGc();
        resourceCounts.push(process.getActiveResourcesInfo().length);
        heapUsedBytes.push(process.memoryUsage().heapUsed);
      }

      // "Does not monotonically increase", checked directly (see
      // isStrictlyIncreasing's doc comment) for both the active-resource
      // handle count and the parent's own (post-forced-GC) heap usage,
      // *including* the pre-cycle baseline as the series' first element so
      // a leak in cycle 1 alone is not invisible to this check — the
      // original reviewer feedback this rework addresses specifically
      // called out that handle count alone, checked only against its own
      // peak, was not sufficient.
      expect(isStrictlyIncreasing([baselineResourceCount, ...resourceCounts])).toBe(false);
      expect(isStrictlyIncreasing([baselineHeapUsed, ...heapUsedBytes])).toBe(false);

      // And bounded overall: the final sample should be close to the
      // pre-cycle baseline, not just "not the single worst value" (which
      // any bounded series trivially satisfies) and not just "close to the
      // post-cycle-1 sample" (which would hide a leak already incurred by
      // cycle 1) — this also catches a slower leak (e.g. +1 handle every
      // other cycle) that isn't strictly increasing at *every* step but
      // still trends upward across the whole run.
      expect(resourceCounts[resourceCounts.length - 1]).toBeLessThanOrEqual(baselineResourceCount + 2);
      const heapGrowthBytes = heapUsedBytes[heapUsedBytes.length - 1] - baselineHeapUsed;
      // 10MB headroom for jest/test-harness noise (IPC payload buffers,
      // per-cycle closures, ...) that is not itself evidence of a leak in
      // the fork/render/kill cycle under test.
      expect(heapGrowthBytes).toBeLessThan(10 * 1024 * 1024);
      // 10 cold starts, each budgeted up to WORKER_READY_TIMEOUT_MS, plus
      // slack for the renders/kills themselves — see WORKER_READY_TIMEOUT_MS's
      // doc comment.
    },
    10 * WORKER_READY_TIMEOUT_MS + 30_000,
  );
});

/**
 * §8 D — native-addon dependency audit (1回, not per-render). Walks the
 * resolved dependency tree of `mermaid` + `jsdom` (the Phase 0 candidate)
 * and confirms none of it is a native addon (`.node` binary, a
 * `binding.gyp`, or a `node-gyp`/`prebuild-install`/`node-pre-gyp`
 * install/postinstall script) — §10's deny-by-default worker boundary
 * (deleting/stubbing `fetch`/`XMLHttpRequest`/etc., blocking
 * `node:net`/`dns`/...) only works against *JS-land* code; a native
 * addon can reach the OS socket API directly and bypass all of it.
 */
describe('Phase 0 gate D: native-addon dependency audit (mermaid + jsdom)', () => {
  interface AuditFinding {
    name: string;
    hasBindingGyp: boolean;
    hasNativeInstallScript: boolean;
    hasCompiledNodeFile: boolean;
  }

  function walkDependencyTree(rootPackageNames: readonly string[]): { visitedCount: number; findings: AuditFinding[] } {
    const visited = new Set<string>();
    const findings: AuditFinding[] = [];

    function walk(pkgDir: string): void {
      const pkgJsonPath = path.join(pkgDir, 'package.json');
      let pkgJson: {
        name?: string;
        version?: string;
        dependencies?: Record<string, string>;
        optionalDependencies?: Record<string, string>;
        scripts?: Record<string, string>;
      };
      try {
        pkgJson = JSON.parse(readFileSync(pkgJsonPath, 'utf8'));
      } catch {
        return;
      }
      const key = `${pkgJson.name ?? pkgDir}@${pkgJson.version ?? '?'}`;
      if (visited.has(key)) return;
      visited.add(key);

      const hasBindingGyp = (() => {
        try {
          statSync(path.join(pkgDir, 'binding.gyp'));
          return true;
        } catch {
          return false;
        }
      })();
      const scripts = pkgJson.scripts ?? {};
      const nativeScriptPattern = /node-gyp|prebuild-install|node-pre-gyp/;
      const hasNativeInstallScript = nativeScriptPattern.test(scripts.postinstall ?? '') || nativeScriptPattern.test(scripts.install ?? '');
      const hasCompiledNodeFile = containsNodeFile(pkgDir, 0);

      if (hasBindingGyp || hasNativeInstallScript || hasCompiledNodeFile) {
        findings.push({ name: key, hasBindingGyp, hasNativeInstallScript, hasCompiledNodeFile });
      }

      const deps = { ...(pkgJson.dependencies ?? {}), ...(pkgJson.optionalDependencies ?? {}) };
      for (const depName of Object.keys(deps)) {
        try {
          const depPkgJsonPath = require.resolve(path.join(depName, 'package.json'), { paths: [pkgDir] });
          walk(path.dirname(depPkgJsonPath));
        } catch {
          // Optional dependency not actually installed (e.g. jsdom's
          // optional `canvas` peer) — nothing to audit if it's not there.
        }
      }
    }

    function containsNodeFile(dir: string, depth: number): boolean {
      if (depth > 6) return false;
      let entries: Dirent[];
      try {
        entries = readdirSync(dir, { withFileTypes: true, encoding: 'utf8' });
      } catch {
        return false;
      }
      for (const entry of entries) {
        if (entry.name === 'node_modules') continue;
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          if (containsNodeFile(full, depth + 1)) return true;
        } else if (entry.name.endsWith('.node')) {
          return true;
        }
      }
      return false;
    }

    for (const name of rootPackageNames) {
      const pkgJsonPath = require.resolve(path.join(name, 'package.json'));
      walk(path.dirname(pkgJsonPath));
    }

    return { visitedCount: visited.size, findings };
  }

  it('mermaid + jsdom resolved dependency tree contains no native addons', () => {
    const { visitedCount, findings } = walkDependencyTree(['mermaid', 'jsdom']);

    // Sanity check that the walk actually traversed a real tree (both
    // packages have substantial dependency graphs) rather than silently
    // no-op'ing on a resolution failure.
    expect(visitedCount).toBeGreaterThan(20);

    if (findings.length > 0) {
      // §10's deny-by-default worker boundary is JS-land only; a native
      // addon in the tree can bypass it entirely. Phase 0's job here is
      // to fail loudly with the concrete offending package list (per §8
      // D's "含まれる場合はその一覧と...評価をspikeの成果物に記録している"),
      // not to silently accept the residual risk.
      throw new Error(
        `native addon(s) found in mermaid+jsdom dependency tree — §10's JS-land deny-by-default boundary cannot cover these:\n${JSON.stringify(findings, null, 2)}`,
      );
    }
  });
});
