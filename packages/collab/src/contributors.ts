import Debug from 'debug';

const debug = Debug('crowi:collab:contributors');

/**
 * RFC-0003 Phase 5 — per-pageId awareness participant log.
 *
 * The Hocuspocus `onAwarenessUpdate` hook fires every time a connected
 * client publishes its awareness state (cursor / user metadata). We
 * pluck `states[i].user.id` out of every visible state and accumulate
 * a `Set<userId>` per pageId; the save flow drains the set into the
 * new Revision's `contributors` array.
 *
 * The tracker is **process-local + closure-scoped** by design:
 *
 *   - Process-local: each collab instance keeps its own set. Multi-
 *     instance contributors aggregation is deliberately deferred to
 *     RFC-0005 (Phase 9 advisory) because (a) RFC-0003 spec §5.5
 *     accepts best-effort semantics, (b) Redis-backed presence is the
 *     RFC-0005 charter, (c) shipping a cross-instance set now would
 *     duplicate work and likely drift.
 *
 *   - Closure-scoped: tests construct a fresh tracker per case so
 *     state never leaks between tests. The collab server has exactly
 *     one tracker per `createCollabServer` invocation.
 *
 * Semantics:
 *   - `record(pageId, userId)` is idempotent (Set add).
 *   - `drain(pageId)` returns the current member array AND clears the
 *     set so the next save only sees post-save contributors.
 *   - `clear(pageId)` is an optional defensive hook for page-unload
 *     paths; not currently wired but handy for future cleanup.
 *
 * `userId` is intentionally typed as `string` because awareness
 * payloads originate from the client and we don't want to leak
 * ObjectId-or-string ambiguity through this layer.
 */
export interface ContributorsTracker {
  /** Add `userId` to the pageId's awareness set. */
  record(pageId: string, userId: string): void;
  /** Return current members AND clear the set (atomic read-then-clear). */
  drain(pageId: string): string[];
  /** Drop the entire entry for `pageId`. */
  clear(pageId: string): void;
  /** Test-only: peek without draining. */
  _peek(pageId: string): string[];
}

export function createContributorsTracker(): ContributorsTracker {
  const sets = new Map<string, Set<string>>();

  return {
    record(pageId, userId) {
      if (!pageId || !userId) return; // defensive — awareness states sometimes lack a user
      let entry = sets.get(pageId);
      if (!entry) {
        entry = new Set<string>();
        sets.set(pageId, entry);
      }
      entry.add(userId);
      debug('record(%s, %s) — set size=%d', pageId, userId, entry.size);
    },
    drain(pageId) {
      const entry = sets.get(pageId);
      if (!entry || entry.size === 0) return [];
      const out = Array.from(entry);
      // Delete the whole entry rather than `entry.clear()`: a long-
      // running collab process touching N distinct pages would
      // otherwise retain N empty `Set` objects forever. `record` is
      // already idempotent on a missing entry (creates a new Set), so
      // there's no observable difference for callers.
      sets.delete(pageId);
      debug('drain(%s) — %d members', pageId, out.length);
      return out;
    },
    clear(pageId) {
      sets.delete(pageId);
    },
    _peek(pageId) {
      const entry = sets.get(pageId);
      return entry ? Array.from(entry) : [];
    },
  };
}
