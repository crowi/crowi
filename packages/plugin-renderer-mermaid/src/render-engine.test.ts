/**
 * `render-engine.ts` — the child-process pool manager Phase 1 graduates
 * from Phase 0's spike harness. The Phase 0 gates themselves (diagram
 * correctness / no-network / kill-doesn't-leak) stay proven against the
 * spike harness (`render-engine.*.spike.test.ts`, unchanged); this file
 * covers what's genuinely NEW in the production pool: syntax-error
 * classification (`MermaidSyntaxError`) and the timeout → SIGKILL →
 * respawn protocol not blocking the parent process (spec §6 AC).
 */
import type { fork as ForkFn } from 'node:child_process';
import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { LARGE_FLOWCHART_SOURCE } from './__fixtures__/large-flowchart';
import { _shutdownSingletonForTest, MermaidRenderPool, MermaidSyntaxError, renderMermaidSvg } from './render-engine';

// `jest.spyOn(require('node:child_process'), 'fork')` fails with
// "Cannot redefine property: fork" — Node's built-in module namespace
// objects have non-configurable exports, so `jest.mock` (which swaps the
// module registry entry, rather than mutating the real module object's
// property descriptors) is the only way to observe `fork()` calls here.
// `ts-jest` hoists this above the `import` statements above the same way
// `babel-jest` does, so `render-engine.ts`'s own `import { fork } from
// 'node:child_process'` resolves to this mocked module.
jest.mock('node:child_process', () => {
  const actual = jest.requireActual<typeof import('node:child_process')>('node:child_process');
  return { ...actual, fork: jest.fn(actual.fork) };
});

const mockedFork = jest.requireMock<typeof import('node:child_process')>('node:child_process').fork as jest.MockedFunction<typeof ForkFn>;

describe('MermaidRenderPool — lazy initialization (spec §1 AC: "遅延初期化し...プロセス起動時ではなく初回呼び出し時")', () => {
  beforeEach(() => {
    mockedFork.mockClear();
  });

  it('spawns zero child processes merely by constructing a MermaidRenderPool', () => {
    const pool = new MermaidRenderPool({ poolSize: 2 });
    expect(mockedFork).not.toHaveBeenCalled();
    void pool; // never rendered — nothing to shut down, no worker was ever spawned
  });

  it('spawns the pool only on the first render() call — not before', async () => {
    const pool = new MermaidRenderPool({ poolSize: 1 });
    try {
      expect(mockedFork).not.toHaveBeenCalled();
      const svg = await pool.render('flowchart TD\n  A --> B');
      expect(svg).toContain('<svg');
      expect(mockedFork).toHaveBeenCalledTimes(1); // poolSize: 1
    } finally {
      await pool.shutdown();
    }
  }, 30_000);

  it('the process-wide singleton (renderMermaidSvg, index.ts’s sole call surface) spawns nothing merely by being imported/referenced — only the first render() call spawns it', async () => {
    // Module import already happened (top of this file) before this test
    // runs, and no other test in this file has called `renderMermaidSvg`
    // yet — proves import-time has no side effect on `node:child_process`.
    try {
      expect(mockedFork).not.toHaveBeenCalled();
      const svg = await renderMermaidSvg('flowchart TD\n  A --> B');
      expect(svg).toContain('<svg');
      expect(mockedFork).toHaveBeenCalled();
    } finally {
      await _shutdownSingletonForTest();
    }
  }, 30_000);
});

describe('MermaidRenderPool — worker startup crash handling (spec §5 classification B: infra failure, not a silent hang)', () => {
  const SIGNAL_KILLED_WORKER_PATH = path.join(__dirname, '__fixtures__/signal-killed-worker.ts');

  it('rejects render() instead of hanging forever when the worker is torn down by a signal before it sends `ready`', async () => {
    // The fixture worker self-`SIGKILL`s immediately on startup — from
    // the parent's perspective this is observationally identical to a
    // real render-worker.ts process killed mid-startup by an OOM killer
    // or a container runtime signal: `exit` fires with `code === null`,
    // never `ready`. A `spawn()` that only rejects on a non-null,
    // non-zero `code` treats this the same as "still starting up" and
    // never settles — this render() call would hang until the test
    // itself times out if that regressed.
    const pool = new MermaidRenderPool({ poolSize: 1, workerPath: SIGNAL_KILLED_WORKER_PATH });
    try {
      await expect(pool.render('flowchart TD\n  A --> B')).rejects.toThrow(/exited before becoming ready/);
    } finally {
      // The worker is already gone (it killed itself) — `shutdown()` is
      // still safe to call (no slots were ever installed, since
      // `ensureInitialized()`'s `Promise.all` rejected before assigning
      // `this.slots`) and matches every other test's cleanup shape.
      await pool.shutdown();
    }
  }, 10_000);
});

describe('MermaidRenderPool — idle worker crash handling (spec §10 (b) / AC: crash detection + immediate respawn)', () => {
  const IDLE_CRASH_WORKER_PATH = path.join(__dirname, '__fixtures__/idle-crash-worker.ts');

  /** Poll instead of a blind sleep — the fixture keeps re-crashing every ~150ms after each respawn, so waiting exactly as long as needed (not longer) avoids racing a THIRD generation's own self-kill. */
  async function waitUntil(predicate: () => boolean, timeoutMs: number, intervalMs = 15): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (!predicate()) {
      if (Date.now() > deadline) throw new Error('waitUntil: condition not met before timeout');
      await new Promise((resolve) => setTimeout(resolve, intervalMs));
    }
  }

  it('detects a worker that crashes while fully idle (no dispatch() in flight) and respawns it immediately, so the NEXT render() reaches a live worker instead of a dead ChildProcess', async () => {
    const pool = new MermaidRenderPool({ poolSize: 1, workerPath: IDLE_CRASH_WORKER_PATH });
    try {
      const forkCallsBefore = mockedFork.mock.calls.length;

      // First render — the single worker answers normally and the slot
      // goes back to idle (busy=false, no pending job) once this
      // resolves.
      const first = await pool.render('flowchart TD\n  A --> B');
      expect(first).toContain('idle-crash-worker reply');
      expect(mockedFork.mock.calls.length).toBe(forkCallsBefore + 1); // only the initial pool spawn so far

      // The fixture self-`SIGKILL`s ~150ms after its own startup, well
      // AFTER the reply above — no `dispatch()` call is in flight when
      // it dies, so `dispatch()`'s own `catch` block (which only runs
      // for a crash mid-render) never sees this at all. If the
      // persistent `exit` handler in `spawn()` did not respawn on an
      // idle exit, `fork` would never be called a second time here.
      await waitUntil(() => mockedFork.mock.calls.length >= forkCallsBefore + 2, 5_000);

      // The respawned worker is live and answers — proves the pool
      // replaced the dead `ChildProcess` reference for this slot BEFORE
      // the next dispatch, rather than the caller either hanging
      // forever or hitting a synchronous `send()` failure on a dead
      // process.
      const second = await pool.render('flowchart TD\n  A --> B');
      expect(second).toContain('idle-crash-worker reply');
    } finally {
      await pool.shutdown();
    }
  }, 15_000);
});

describe('MermaidRenderPool', () => {
  it('renders a simple diagram to a well-formed SVG string', async () => {
    const pool = new MermaidRenderPool({ poolSize: 1 });
    try {
      const svg = await pool.render('flowchart TD\n  A --> B');
      expect(svg).toMatch(/^<svg[\s>]/);
      expect(svg).toContain('</svg>');
    } finally {
      await pool.shutdown();
    }
  }, 30_000);

  it('rejects with MermaidSyntaxError (not a generic Error) for malformed Mermaid source, and the worker stays usable afterward', async () => {
    const pool = new MermaidRenderPool({ poolSize: 1 });
    try {
      await expect(pool.render('this is not a valid mermaid diagram @@@ ###')).rejects.toBeInstanceOf(MermaidSyntaxError);
      // The worker that answered `ok:false` is healthy — no respawn was
      // needed, so the very next render on the same (single-worker) pool
      // must still succeed.
      const svg = await pool.render('flowchart TD\n  A --> B');
      expect(svg).toContain('<svg');
    } finally {
      await pool.shutdown();
    }
  }, 30_000);

  // 350ms: comfortably under the large flowchart's ~700-900ms real render
  // time (so 'a timeout does not block the parent process' below reliably
  // times out). 'recovers after a timeout' also uses this constant but no
  // longer needs margin for real render latency — it uses a deterministic
  // fixture worker instead (see RECOVERY_FIXTURE_WORKER_PATH below).
  const SHORT_TIMEOUT_MS = 350;
  const RECOVERY_FIXTURE_WORKER_PATH = path.join(__dirname, '__fixtures__/recovery-fixture-worker.ts');

  it('a timeout does not block the parent process — a concurrent timer keeps firing while the render call is pending', async () => {
    const pool = new MermaidRenderPool({ poolSize: 1, timeoutMs: SHORT_TIMEOUT_MS });
    try {
      let parentTicks = 0;
      const ticker = setInterval(() => {
        parentTicks += 1;
      }, 10);

      const renderPromise = pool.render(LARGE_FLOWCHART_SOURCE); // ~700-900ms real render, well past the timeout
      await expect(renderPromise).rejects.toThrow(/timed out/);

      clearInterval(ticker);
      // If the parent had blocked while waiting for the timeout, this
      // would be 0 (or very small). Several ticks over the wait proves
      // the event loop kept running other work.
      expect(parentTicks).toBeGreaterThan(3);
    } finally {
      await pool.shutdown();
    }
  }, 30_000);

  it('recovers after a timeout — the respawned worker serves the next render successfully', async () => {
    // Uses a deterministic fixture worker (never imports mermaid/jsdom,
    // never replies to its first render) instead of a real slow render —
    // what this test actually verifies is the timeout→kill→respawn
    // PROTOCOL, not real render latency, so it shouldn't share a timing
    // budget with genuine Mermaid rendering (see the fixture's own doc
    // comment for why the old real-render version could flake under
    // CI/sibling-suite CPU contention).
    // Path shared by hardcoded convention with the fixture worker itself
    // (see its doc comment for why this isn't an env var: a `process.env`
    // mutation made here is invisible to a REAL `fork()`ed child under
    // ts-jest, confirmed empirically), keyed by this process's own pid —
    // `render-engine.ts`'s `spawn()` forks the fixture directly from here,
    // so the fixture's `process.ppid` always equals this `process.pid`.
    // Keeps two concurrent `render-engine.test.ts` runs on the same
    // machine (e.g. two worktrees) from sharing a sentinel. Removed before
    // AND after so a previous run's leftover state (a crashed test, e.g.)
    // can never leak in as a false "this is a respawn" signal.
    const sentinelPath = path.join(tmpdir(), `crowi-mermaid-recovery-fixture-${process.pid}.sentinel`);
    rmSync(sentinelPath, { force: true });
    const pool = new MermaidRenderPool({ poolSize: 1, timeoutMs: SHORT_TIMEOUT_MS, workerPath: RECOVERY_FIXTURE_WORKER_PATH });
    try {
      await expect(pool.render('flowchart TD\n  A --> B')).rejects.toThrow(/timed out/);
      // `acquireSlot()` for this next call queues until the respawn
      // triggered by the timeout above hands the slot off (`releaseSlot`
      // only fires once the fresh worker is confirmed ready) — so this
      // is never racing the respawn itself, only the render call after.
      const svg = await pool.render('flowchart TD\n  A --> B');
      expect(svg).toContain('<svg');
    } finally {
      await pool.shutdown();
      rmSync(sentinelPath, { force: true });
    }
  }, 30_000);

  it('serves N concurrent renders through a smaller pool without deadlocking (internal wait-queue hand-off)', async () => {
    const pool = new MermaidRenderPool({ poolSize: 2 });
    try {
      const sources = Array.from({ length: 5 }, (_, i) => `flowchart TD\n  A${i} --> B${i}`);
      const results = await Promise.all(sources.map((s) => pool.render(s)));
      expect(results).toHaveLength(5);
      for (const svg of results) expect(svg).toContain('<svg');
    } finally {
      await pool.shutdown();
    }
  }, 30_000);
});
