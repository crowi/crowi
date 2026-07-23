/**
 * Shared bounded-concurrency semaphore (feature-renderer-core-util-dedup).
 *
 * Used by both the link-card OGP fetcher
 * (`renderer/core/link-card/fetch-og.ts`) and the image display-derivative
 * upload admission (`util/image-display-derivative.ts`). Previously each
 * had its own hand-rolled semaphore with a DIFFERENT interface shape, and
 * only one of the two bounded its wait queue (a high-severity DoS fix —
 * see `fetch-og.ts`'s `FETCH_QUEUE_LIMIT` / `FETCH_QUEUE_WAIT_MS`, commit
 * 2a9c55e5). This is now the one implementation both consolidate onto —
 * the queue-length cap + wait timeout it provides are a property of every
 * caller, not an opt-in one of them happened to add.
 *
 * Bounded on two axes:
 *   - `queueLimit` caps how many callers may ever sit in the wait queue at
 *     once — beyond it, `acquire()` fails synchronously with
 *     `{ ok: false }` without ever constructing a `Promise` that would sit
 *     unresolved, so the total number of outstanding acquisitions
 *     (active + queued) never exceeds `max + queueLimit`, a constant, no
 *     matter how many callers pile on at once.
 *   - `waitMs` caps how long an accepted waiter may sit in the queue
 *     before giving up the same way (`{ ok: false }`) — a separate,
 *     PRE-acquisition deadline from whatever the caller does with a
 *     granted slot.
 *
 * Both knobs are per-caller-workload decisions (a network-fetch fan-out
 * and a CPU-bound image-encode admission gate size these very
 * differently), so neither has a default here — every constructor call
 * supplies its own `max` / `queueLimit` / `defaultWaitMs` (see each call
 * site for its own sizing rationale).
 */
export type SemaphoreAcquireResult = { ok: true; release: () => void } | { ok: false };

export class Semaphore {
  private active = 0;
  private readonly queue: Array<() => void> = [];

  constructor(
    private readonly max: number,
    private readonly queueLimit: number,
    private readonly defaultWaitMs: number,
  ) {}

  /**
   * `waitMsOverride` lets a caller whose own wait deadline is read fresh
   * per call (e.g. image derivative's `resolveAdmissionTimeoutMs()`,
   * intentionally NOT cached so config/tests can change it between
   * calls) supply it per-acquisition instead of the fixed `defaultWaitMs`
   * set at construction time. Omit it to use `defaultWaitMs` (link-card's
   * usage — a fixed constant every call).
   */
  async acquire(waitMsOverride?: number): Promise<SemaphoreAcquireResult> {
    if (this.active < this.max) {
      this.active++;
      return this.grantSlot();
    }
    if (this.queue.length >= this.queueLimit) {
      // Queue-length cap reached — the core DoS fix. Fail synchronously
      // without ever pushing a new entry onto `queue`, so the total
      // count of outstanding acquisitions (active + queued) never
      // exceeds `max + queueLimit`, a constant, regardless of how many
      // callers pile on in one dispatch.
      return { ok: false };
    }
    const waitMs = waitMsOverride ?? this.defaultWaitMs;
    return new Promise<SemaphoreAcquireResult>((resolve) => {
      // No separate "settled" flag needed: `grant` can only run once,
      // from one of two mutually-exclusive places — `release()`'s
      // `queue.shift()` (which physically removes this entry from
      // `queue` first) or the timer below (cleared by `grant` the
      // instant it runs). The timer's own `indexOf` check against
      // `queue` already tells it whether `release()` won the race.
      const grant = (): void => {
        clearTimeout(timer);
        this.active++;
        resolve(this.grantSlot());
      };
      const timer = setTimeout(() => {
        const idx = this.queue.indexOf(grant);
        if (idx === -1) return; // already granted via release()
        this.queue.splice(idx, 1);
        resolve({ ok: false });
      }, waitMs);
      this.queue.push(grant);
    });
  }

  private grantSlot(): SemaphoreAcquireResult {
    return { ok: true, release: () => this.release() };
  }

  private release(): void {
    this.active--;
    const next = this.queue.shift();
    if (next) next();
  }
}
