import type { HistoryTrackingState, PageDocument } from 'src/models/page';

/**
 * RFC-0021 §5.5a (`feature-page-history-phase1-model`, Phase 1) — the
 * authoritative status gate every history-producing writer must call before
 * mutating a Page. `historyTracking.state !== 'ready'` means "retry later,
 * nothing changed" — never a partial write, never an apparently-complete
 * one.
 *
 * Phase 1 ships this gate with NO caller: Phase 2's command cutover
 * (rename / grant / trash / restore / publish / create) is what actually
 * calls it. This module and its test exist so every branch is fixed ahead
 * of that cutover, per RFC §16.1's "add failure-injection tests before
 * enabling writers".
 */

/** Thrown by {@link requireHistoryReady} for `untracked` / `migrating` — always retryable, never a sign the request itself was invalid. */
export class HistoryMigratingError extends Error {
  /** Matches the spec's `409 history_migrating` error semantics — a future Hono handler maps this to a 409 JSON body. */
  readonly status = 409;
  readonly code = 'history_migrating' as const;
  readonly state: HistoryTrackingState;

  constructor(state: HistoryTrackingState) {
    super(`Page history tracking is not ready (state: "${state}") — retry`);
    this.name = 'HistoryMigratingError';
    this.state = state;
  }
}

/**
 * Reads (never writes) `page.historyTracking.state`. Passes silently for
 * `'ready'`; throws {@link HistoryMigratingError} for `'untracked'` or
 * `'migrating'` — and for a legacy Page whose `historyTracking` is entirely
 * absent, which is equivalent to `'untracked'` (RFC §13.1: "Page defaults
 * remain readable during expansion, but history-producing writes stay
 * behind the migration gate").
 *
 * The Page argument is accepted by structural type only (`Pick`) so a
 * caller can gate on a partial projection (`.select('historyTracking')`)
 * without loading the whole document.
 */
export function requireHistoryReady(page: Pick<PageDocument, 'historyTracking'>): void {
  const state: HistoryTrackingState = page.historyTracking?.state ?? 'untracked';
  if (state !== 'ready') {
    throw new HistoryMigratingError(state);
  }
}
