/**
 * `renderMermaidSvg(source)` — the sole public surface `index.ts` calls
 * (spec §1). Internally owns a `fork()`ed child-process worker pool
 * (spec §6 / §10): lazy init (first call spawns the pool), pool size
 * fixed to admission control's `maxConcurrentGlobal` (4), and the
 * termination protocol spec §10 specifies — timeout → `SIGKILL` +
 * immediate respawn, crash → immediate respawn, per-worker heap cap via
 * `--max-old-space-size`, periodic recycling at 500 renders / 30min.
 *
 * Error contract (spec §5): a Mermaid *notation* failure — the worker
 * responded, but `mermaid.render()` itself threw inside it — rejects
 * with `MermaidSyntaxError`, which `index.ts` catches and turns into a
 * classification-A result. Every OTHER rejection (timeout, crash, a
 * respawn that never became ready) is a classification-B infra failure
 * that `index.ts` does NOT catch — it propagates up to
 * `cachedRenderOrPending` (`packages/api/src/renderer/cache/index.ts`),
 * which treats any thrown error under admission the same way.
 */

import { type ChildProcess, fork } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import type { RenderRequestMessage, WorkerOutboundMessage } from './worker-protocol';

/** A worker responded, but the source itself did not render (bad Mermaid syntax) — spec §5 classification A. */
export class MermaidSyntaxError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MermaidSyntaxError';
  }
}

export interface MermaidRenderPoolOptions {
  /** Fixed child-process pool size. Default 4 — must match admission control's `maxConcurrentGlobal` (spec §6). */
  poolSize?: number;
  /** Per-render timeout before `SIGKILL` + respawn. Default 5000ms (spec §10). */
  timeoutMs?: number;
  /** Renders before a worker retires itself. Default 500 (spec §10 (d)). */
  maxRendersPerWorker?: number;
  /** Wall-clock uptime before a worker retires itself. Default 30 minutes (spec §10 (d)). */
  maxUptimeMs?: number;
  /** `--max-old-space-size` per worker, in MB. Default 256 (spec §10 (c)). */
  heapLimitMb?: number;
  /** Override the forked entry path — test-only escape hatch. Default: `resolveWorkerEntryPath()`. */
  workerPath?: string;
}

interface PendingJob {
  resolve: (svg: string) => void;
  reject: (err: Error) => void;
}

class WorkerSlot {
  renderCount = 0;
  readonly spawnedAt = Date.now();
  readonly pending = new Map<number, PendingJob>();
  /**
   * Set right before `dispatch()`'s timeout path deliberately
   * `kill()`s this slot's child — the ONLY deliberate kill that does
   * NOT also `removeAllListeners()` first (see `doRespawnSlot`/
   * `shutdown()`, which do), so it is the only case where the
   * persistent `exit` handler below would otherwise mistake an
   * already-handled, expected exit for a genuine crash and try to
   * respawn a second time on top of that timeout path's own respawn.
   */
  expectingExit = false;
  constructor(public child: ChildProcess) {}
}

/**
 * Resolve the `fork()` entry path (spec §10 "CJS/ESM でのworkerパス解決
 * 戦略"): the CJS `dist/render-worker.js` sibling of this module's own
 * built output when it exists (production — `@crowi/runner` always
 * `require()`s the plugin, so `__dirname` is always the `dist/`
 * directory there), otherwise the `.ts` source directly (dev/test,
 * before `tsup` has run — Node 24's native TypeScript support strips
 * types the same way Phase 0's spike forked `spike-worker.ts` directly).
 */
export function resolveWorkerEntryPath(): string {
  const builtPath = path.join(__dirname, 'render-worker.js');
  if (existsSync(builtPath)) return builtPath;
  return path.join(__dirname, 'render-worker.ts');
}

export class MermaidRenderPool {
  private readonly poolSize: number;
  private readonly timeoutMs: number;
  private readonly maxRendersPerWorker: number;
  private readonly maxUptimeMs: number;
  private readonly heapLimitMb: number;
  private readonly workerPath: string;

  private slots: WorkerSlot[] = [];
  private busy: boolean[] = [];
  private waitQueue: Array<(idx: number) => void> = [];
  private initPromise: Promise<void> | null = null;
  private nextMsgId = 1;
  // A timeout/crash kicks off `respawnSlot` fire-and-forget (spec §6 —
  // the caller must not block waiting for the respawn). Tracked here so
  // `shutdown()` can wait for every in-flight respawn to settle instead
  // of racing it — without this, a respawn's freshly-forked child could
  // finish spawning AFTER `shutdown()` already killed everything it knew
  // about, leaking an orphaned worker process forever.
  private pendingRespawns = new Set<Promise<void>>();
  private shuttingDown = false;

  constructor(options: MermaidRenderPoolOptions = {}) {
    this.poolSize = options.poolSize ?? 4;
    this.timeoutMs = options.timeoutMs ?? 5000;
    this.maxRendersPerWorker = options.maxRendersPerWorker ?? 500;
    this.maxUptimeMs = options.maxUptimeMs ?? 30 * 60 * 1000;
    this.heapLimitMb = options.heapLimitMb ?? 256;
    this.workerPath = options.workerPath ?? resolveWorkerEntryPath();
  }

  /** Render one Mermaid source. Lazily initialises the pool on the very first call. */
  async render(source: string): Promise<string> {
    await this.ensureInitialized();
    const idx = await this.acquireSlot();
    return this.dispatch(idx, source);
  }

  /** Kill every worker. Test-only / graceful-shutdown use — production never needs this within a request lifecycle. */
  async shutdown(): Promise<void> {
    this.shuttingDown = true;
    await this.initPromise?.catch(() => undefined);
    await Promise.allSettled([...this.pendingRespawns]);
    for (const slot of this.slots) {
      slot.child.removeAllListeners();
      slot.child.kill('SIGKILL');
    }
    this.slots = [];
    this.busy = [];
    this.waitQueue = [];
    this.initPromise = null;
  }

  private ensureInitialized(): Promise<void> {
    if (!this.initPromise) {
      this.initPromise = (async () => {
        const spawned = await Promise.all(Array.from({ length: this.poolSize }, (_, idx) => this.spawn(idx)));
        this.slots = spawned;
        this.busy = spawned.map(() => false);
      })();
    }
    return this.initPromise;
  }

  private acquireSlot(): Promise<number> {
    const idx = this.busy.indexOf(false);
    if (idx !== -1) {
      this.busy[idx] = true;
      return Promise.resolve(idx);
    }
    return new Promise<number>((resolve) => this.waitQueue.push(resolve));
  }

  /**
   * Hand a just-freed slot directly to the next waiter (kept `busy` the
   * whole time — no free/re-scan race) or, if none, mark it free.
   */
  private releaseSlot(idx: number): void {
    const waiter = this.waitQueue.shift();
    if (waiter) {
      waiter(idx);
      return;
    }
    this.busy[idx] = false;
  }

  private async spawn(idx: number): Promise<WorkerSlot> {
    const child = fork(this.workerPath, {
      execArgv: ['--no-warnings', `--max-old-space-size=${this.heapLimitMb}`],
      stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
    });
    const slot = new WorkerSlot(child);

    await new Promise<void>((resolve, reject) => {
      const onMessage = (msg: WorkerOutboundMessage) => {
        if (msg.type !== 'ready') return;
        child.off('message', onMessage);
        child.off('exit', onExit);
        resolve();
      };
      // Any exit before `ready` is a startup failure, full stop — not
      // just a non-zero exit `code`. A worker torn down by a signal
      // (OOM killer, `SIGKILL`/`SIGTERM` from an operator or container
      // runtime, a crash that raises SIGSEGV/SIGABRT) reports `code ===
      // null` here, exactly like Node's own "still starting up" state
      // before any exit has happened at all — a `code !== 0 && code !==
      // null` check treats a signal-killed worker as if it simply hadn't
      // finished starting yet, and `resolve()` never comes, so
      // `ensureInitialized()` (and every `render()` call queued behind
      // it) hangs forever instead of surfacing an infra failure (spec §5
      // classification B) the caller can recover from.
      const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
        child.off('message', onMessage);
        reject(new Error(`render-worker exited before becoming ready (code=${code}, signal=${signal})`));
      };
      child.on('message', onMessage);
      child.once('error', reject);
      child.once('exit', onExit);
    });

    child.on('message', (msg: WorkerOutboundMessage) => {
      if (msg.type !== 'render-result') return;
      const job = slot.pending.get(msg.id);
      if (!job) return; // already settled by the timeout path below
      slot.pending.delete(msg.id);
      if (msg.ok) job.resolve(msg.svg);
      else job.reject(new MermaidSyntaxError(msg.error));
    });
    child.on('exit', (code, signal) => {
      // Any job still pending here was NOT settled by a deliberate
      // timeout-kill (that path removes its own pending entry before
      // calling `kill()`) — so a non-empty `pending` here always means
      // an unexpected crash mid-dispatch.
      const hadPendingJobs = slot.pending.size > 0;
      for (const job of slot.pending.values()) {
        job.reject(new Error(`render-worker crashed unexpectedly (code=${code}, signal=${signal})`));
      }
      slot.pending.clear();

      if (slot.expectingExit) {
        // The timeout path in `dispatch()` already killed this child
        // deliberately and owns its own respawn (see the `setTimeout`
        // callback below) — nothing more to do here.
        return;
      }
      if (hadPendingJobs) {
        // A crash while a job was in flight: the pending job's
        // rejection above propagates out of `dispatch()`'s `await
        // resultPromise`, and `dispatch()`'s own `catch` block already
        // triggers a respawn for this exact case — triggering a SECOND,
        // concurrent respawn from here would race it.
        return;
      }
      if (this.shuttingDown) return; // matches `doRespawnSlot`'s own shutdown guard.
      // A crash while genuinely idle (no `dispatch()` call is in
      // flight for this slot to notice via its own catch block) — spec
      // §10 (b) / AC "クラッシュ検知 + 即時再生成" requires detecting this
      // immediately, not merely on the NEXT `dispatch()` attempt (which
      // would otherwise `send()` to an already-dead `ChildProcess`).
      // This handler is therefore the only place that can catch it.
      // Reserve the slot (mirrors the timeout path below) BEFORE
      // kicking off the respawn so `acquireSlot()` cannot hand this
      // idx to a new `render()` call while `this.slots[idx]` still
      // points at the dead child — without this, a `render()` racing
      // in during the respawn window would still `send()` to it and
      // fail. `releaseSlot` only runs once `this.slots[idx]` has
      // already been swapped to the fresh, ready worker.
      this.busy[idx] = true;
      void this.respawnSlot(idx).finally(() => this.releaseSlot(idx));
    });

    return slot;
  }

  private async dispatch(idx: number, source: string): Promise<string> {
    await this.recycleIfDue(idx);
    const slot = this.slots[idx];
    const id = this.nextMsgId++;

    const resultPromise = new Promise<string>((resolve, reject) => {
      slot.pending.set(id, { resolve, reject });
    });

    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      const job = slot.pending.get(id);
      slot.pending.delete(id);
      // Mark this exit as already-handled BEFORE killing — the
      // persistent `exit` handler installed in `spawn()` must not treat
      // this deliberate kill as an unexpected idle crash and respawn a
      // second time on top of the explicit respawn below.
      slot.expectingExit = true;
      slot.child.kill('SIGKILL');
      job?.reject(new Error(`render-worker timed out after ${this.timeoutMs}ms`));
      // Respawn + free happen asynchronously, AFTER the reject above —
      // callers observe the rejection immediately; the parent process's
      // event loop is never blocked waiting for the respawn (spec §6
      // AC: "レンダリング呼び出し中に親プロセスがブロックされないこと").
      void this.respawnSlot(idx).finally(() => this.releaseSlot(idx));
    }, this.timeoutMs);

    slot.child.send({ type: 'render', id, source } satisfies RenderRequestMessage);

    try {
      const svg = await resultPromise;
      slot.renderCount += 1;
      return svg;
    } catch (err) {
      // A `MermaidSyntaxError` came from a HEALTHY worker (it responded
      // `ok:false`) — the slot needs no respawn. A timeout already
      // scheduled its own respawn+release above. Anything else reaching
      // here is the crash path (the slot's `exit` handler rejected) and
      // still needs a respawn.
      if (!timedOut && !(err instanceof MermaidSyntaxError)) {
        await this.respawnSlot(idx);
      }
      throw err;
    } finally {
      clearTimeout(timer);
      if (!timedOut) this.releaseSlot(idx);
    }
  }

  private async recycleIfDue(idx: number): Promise<void> {
    const slot = this.slots[idx];
    const uptimeMs = Date.now() - slot.spawnedAt;
    if (slot.renderCount < this.maxRendersPerWorker && uptimeMs < this.maxUptimeMs) return;
    await this.respawnSlot(idx);
  }

  private respawnSlot(idx: number): Promise<void> {
    const promise = this.doRespawnSlot(idx);
    this.pendingRespawns.add(promise);
    // Fire-and-forget bookkeeping — the returned promise IS awaited by
    // `shutdown()`, just not by every caller.
    void promise.finally(() => this.pendingRespawns.delete(promise));
    return promise;
  }

  private async doRespawnSlot(idx: number): Promise<void> {
    const old = this.slots[idx];
    try {
      old.child.removeAllListeners();
      if (!old.child.killed) old.child.kill('SIGKILL');
    } catch {
      // best-effort — the process may already be gone.
    }
    try {
      const fresh = await this.spawn(idx);
      if (this.shuttingDown) {
        // `shutdown()` may have run to completion (or be in progress)
        // while this respawn's `fork()` was still starting up — never
        // install a fresh worker after that point, and kill the one
        // that just finished spawning instead of leaking it.
        fresh.child.removeAllListeners();
        fresh.child.kill('SIGKILL');
        return;
      }
      this.slots[idx] = fresh;
    } catch (err) {
      // Respawn failing is a serious operational problem but must not
      // crash the api process. The slot keeps pointing at the dead
      // child; the next dispatch to it will fail fast (a `send()` on a
      // dead `ChildProcess` throws) and retrigger this same path — only
      // this one slot is affected, never the whole pool.
      console.error('[render-engine] failed to respawn a Mermaid render worker', err);
    }
  }
}

let singleton: MermaidRenderPool | null = null;

/**
 * `render-engine.ts`'s sole public export (spec §1). Lazily initialises
 * a process-wide singleton pool on first call (never at module load /
 * process startup).
 */
export function renderMermaidSvg(source: string): Promise<string> {
  singleton ??= new MermaidRenderPool();
  return singleton.render(source);
}

/**
 * Test-only — shuts down and clears the process-wide singleton pool so
 * a test file's forked workers don't outlive the test run (Jest warns
 * "did not exit" otherwise). Production code never calls this; the
 * singleton is meant to persist for the api process's lifetime.
 */
export async function _shutdownSingletonForTest(): Promise<void> {
  await singleton?.shutdown();
  singleton = null;
}
