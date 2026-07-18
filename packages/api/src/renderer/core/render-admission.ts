import type { AdmissionControlConfig, RenderActor } from '@crowi/plugin-api';

/**
 * CPU-bound render admission control (spec §6, feature-plugin-renderer-
 * mermaid Phase 1). A process-local, per-`pluginName` pool of "slots" —
 * a plugin opts in by declaring `EmbedRenderer.admissionControl` /
 * `CodeBlockRenderer.admissionControl`, and `cachedRenderOrPending`
 * (`../cache/index.ts`) wraps the actual `renderer.render()` call with
 * `acquireRenderSlot(...)` / `ticket.release()`.
 *
 * Deliberately NOT Redis-backed / cross-instance — spec's "やらないこと"
 * section rules that out explicitly. Each api replica in a multi-instance
 * deployment enforces its own independent limits; the shared MongoDB
 * render cache still dedupes/persists results across instances the same
 * way it always has.
 *
 * Three levers, all per `pluginName`:
 *   - `maxConcurrentGlobal` — process-wide concurrent `render()` calls.
 *   - `maxConcurrentPerUser` — concurrent calls attributable to one
 *     `actor.userId` (actors that aren't `kind: 'user'` are not counted
 *     against any per-user cap — only the global cap applies to them).
 *   - `queueDepth` — jobs allowed to wait for a slot before further
 *     requests are rejected outright (no unbounded queueing).
 *
 * Waiting jobs are ordered `priority: 'high'` before `'low'`, FIFO within
 * the same priority; an already-running job is never preempted.
 */

export type RenderPriority = 'high' | 'low';

export interface RenderSlotTicket {
  /** Idempotent — release a granted slot, freeing capacity for the next queued job. */
  release(): void;
}

export interface AcquireRenderSlotOptions {
  /** Which admission pool — one independent pool per registered plugin name. */
  pluginName: string;
  /** Drives the per-user concurrency cap; non-`'user'` actors are only subject to the global cap. */
  actor: RenderActor;
  /** `'high'` (save / on-the-fly read) always outranks `'low'` (preview) in the wait queue. */
  priority: RenderPriority;
  /**
   * When supplied and the job is still queued (not yet running), an
   * abort removes the job from the queue immediately and rejects with
   * `RenderAdmissionAbortedError` — the caller's per-user queued count
   * is released too. An abort after the job has already been granted a
   * slot has no effect (spec §6 — an in-flight child-process render is
   * not force-killed on preview cancellation).
   */
  signal?: AbortSignal;
  /** The plugin's declared limits (`CodeBlockRenderer.admissionControl` / `EmbedRenderer.admissionControl`). */
  admissionControl: AdmissionControlConfig;
}

/** Thrown by `acquireRenderSlot` when the wait queue is already at `queueDepth`. */
export class RenderAdmissionQueueOverflowError extends Error {
  constructor(pluginName: string, queueDepth: number) {
    super(`render admission queue full for plugin=${pluginName} (queueDepth=${queueDepth})`);
    this.name = 'RenderAdmissionQueueOverflowError';
  }
}

/** Thrown by `acquireRenderSlot` when `signal` aborts (already-aborted at call time, or aborted while queued). */
export class RenderAdmissionAbortedError extends Error {
  constructor(pluginName: string) {
    super(`render admission request aborted while queued for plugin=${pluginName}`);
    this.name = 'RenderAdmissionAbortedError';
  }
}

interface QueuedJob {
  userId: string | null;
  priority: RenderPriority;
  /** Monotonic arrival order — tiebreaker within the same priority (FIFO). */
  seq: number;
  resolve: (ticket: RenderSlotTicket) => void;
  reject: (err: Error) => void;
  signal?: AbortSignal;
  onAbort?: () => void;
}

interface Pool {
  config: AdmissionControlConfig;
  runningGlobal: number;
  /** Only tracks `kind: 'user'` actors — absent key === 0 running for that user. */
  runningPerUser: Map<string, number>;
  queue: QueuedJob[];
}

const pools = new Map<string, Pool>();
let seqCounter = 0;

function getOrCreatePool(pluginName: string, config: AdmissionControlConfig): Pool {
  let pool = pools.get(pluginName);
  if (!pool) {
    pool = { config, runningGlobal: 0, runningPerUser: new Map(), queue: [] };
    pools.set(pluginName, pool);
  }
  return pool;
}

/**
 * Acquire a render slot, waiting in a priority queue if the pool is at
 * capacity. Resolves with a `{ release() }` ticket once a slot is
 * actually granted (which may be immediate). See the module doc comment
 * for the full semantics.
 */
export function acquireRenderSlot(options: AcquireRenderSlotOptions): Promise<RenderSlotTicket> {
  const pool = getOrCreatePool(options.pluginName, options.admissionControl);
  const userId = options.actor.kind === 'user' ? options.actor.userId : null;

  // Checked *before* attempting an immediate grant — an already-aborted
  // signal must reject even when a slot is free right now. Granting first
  // and only honouring `signal` for the queued path would render (and
  // cache, via `cachedRenderOrPending`) a preview the client already gave
  // up on whenever capacity happened to be spare.
  if (options.signal?.aborted) {
    return Promise.reject(new RenderAdmissionAbortedError(options.pluginName));
  }

  const immediate = tryGrantImmediately(pool, userId);
  if (immediate) return Promise.resolve(immediate);

  return new Promise((resolve, reject) => {
    if (pool.queue.length >= pool.config.queueDepth) {
      reject(new RenderAdmissionQueueOverflowError(options.pluginName, pool.config.queueDepth));
      return;
    }

    const job: QueuedJob = {
      userId,
      priority: options.priority,
      seq: seqCounter++,
      resolve,
      reject,
    };
    if (options.signal) {
      const signal = options.signal;
      const onAbort = () => {
        const idx = pool.queue.indexOf(job);
        if (idx !== -1) pool.queue.splice(idx, 1);
        signal.removeEventListener('abort', onAbort);
        reject(new RenderAdmissionAbortedError(options.pluginName));
      };
      job.signal = signal;
      job.onAbort = onAbort;
      signal.addEventListener('abort', onAbort, { once: true });
    }
    pool.queue.push(job);
  });
}

function tryGrantImmediately(pool: Pool, userId: string | null): RenderSlotTicket | null {
  if (!hasCapacity(pool, userId)) return null;
  return grant(pool, userId);
}

function hasCapacity(pool: Pool, userId: string | null): boolean {
  if (pool.runningGlobal >= pool.config.maxConcurrentGlobal) return false;
  if (userId !== null) {
    const userCount = pool.runningPerUser.get(userId) ?? 0;
    if (userCount >= pool.config.maxConcurrentPerUser) return false;
  }
  return true;
}

function grant(pool: Pool, userId: string | null): RenderSlotTicket {
  pool.runningGlobal += 1;
  if (userId !== null) {
    pool.runningPerUser.set(userId, (pool.runningPerUser.get(userId) ?? 0) + 1);
  }
  let released = false;
  return {
    release: () => {
      if (released) return; // idempotent
      released = true;
      pool.runningGlobal -= 1;
      if (userId !== null) {
        const remaining = (pool.runningPerUser.get(userId) ?? 1) - 1;
        if (remaining <= 0) pool.runningPerUser.delete(userId);
        else pool.runningPerUser.set(userId, remaining);
      }
      drainQueue(pool);
    },
  };
}

/**
 * After a release, grant as many queued jobs as current capacity allows.
 * Each iteration picks the highest-priority (then earliest-arrived) job
 * that is *individually* grantable — a saturated user's queued jobs are
 * skipped in favour of a later, non-saturated user's job so one user's
 * queue occupancy cannot block another user's turn once global capacity
 * frees up (spec §6 AC "distinct userが互いのquotaを食い合わない").
 */
function drainQueue(pool: Pool): void {
  for (;;) {
    if (pool.runningGlobal >= pool.config.maxConcurrentGlobal) return;
    const idx = pickNextGrantableIndex(pool);
    if (idx === -1) return;
    const [job] = pool.queue.splice(idx, 1);
    if (job.signal && job.onAbort) job.signal.removeEventListener('abort', job.onAbort);
    job.resolve(grant(pool, job.userId));
  }
}

function pickNextGrantableIndex(pool: Pool): number {
  let bestIdx = -1;
  let bestPriorityRank = Number.POSITIVE_INFINITY;
  let bestSeq = Number.POSITIVE_INFINITY;
  for (let i = 0; i < pool.queue.length; i++) {
    const job = pool.queue[i];
    if (job.userId !== null) {
      const userCount = pool.runningPerUser.get(job.userId) ?? 0;
      if (userCount >= pool.config.maxConcurrentPerUser) continue;
    }
    const rank = job.priority === 'high' ? 0 : 1;
    if (rank < bestPriorityRank || (rank === bestPriorityRank && job.seq < bestSeq)) {
      bestPriorityRank = rank;
      bestSeq = job.seq;
      bestIdx = i;
    }
  }
  return bestIdx;
}

/**
 * Test-only reset — clears every pool's state. Production code never
 * calls this; pools are meant to persist for the lifetime of the
 * process. Exported (not module-private) so `render-admission.test.ts`
 * can isolate test cases without needing a unique `pluginName` per test.
 */
export function _resetAllPoolsForTest(): void {
  pools.clear();
  seqCounter = 0;
}

/**
 * Test-only introspection — the current wait-queue length for a
 * plugin's pool (0 if the pool doesn't exist yet, i.e. nothing has ever
 * called `acquireRenderSlot` for it). Exported so tests can poll for
 * "a job has actually enqueued" deterministically instead of a fixed
 * `setTimeout`, e.g. `cache/index.test.ts`'s signal-abort-while-queued
 * case (waiting on this rather than a wall-clock delay avoids a race
 * between the queued job's real Mongo cache lookup and the abort call).
 * Production code never calls this.
 */
export function _getQueueLengthForTest(pluginName: string): number {
  return pools.get(pluginName)?.queue.length ?? 0;
}
