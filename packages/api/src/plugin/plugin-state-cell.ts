import type { StateCell } from '@crowi/plugin-api';

/**
 * Runtime implementation of `StateCell<T>` (the type lives in
 * `@crowi/plugin-api` — see that package's doc comment on why the
 * package only ships types, not implementations). Backs
 * `PluginContext.state()`; see `plugin-context.ts` / `plugin-manager.ts`
 * for how a cell is created once per plugin and shared across every
 * `PluginContext` instance for that plugin (activation-time `ctx` +
 * every later `reconfigure(ctx)`).
 *
 * Each `set()` starts a new "generation". A generation's value is only
 * disposed once (a) it is no longer the live generation, and (b) every
 * `withValue()` call that captured it has settled — tracked via a
 * per-generation `refCount`. `dispose` always runs on a fresh microtask
 * (never inline from `set()`), matching the `StateCell.set()` contract.
 */
export function createStateCell<T>(initial: T): StateCell<T> {
  let generation = 0;
  let current = initial;
  const generations = new Map<number, { value: T; refCount: number; dispose?: (v: T) => void | Promise<void> }>();
  generations.set(0, { value: initial, refCount: 0 });

  function maybeDispose(gen: number): void {
    if (gen === generation) return; // never dispose the live generation
    const entry = generations.get(gen);
    if (!entry || entry.refCount > 0) return;
    generations.delete(gen);
    if (entry.dispose) {
      const dispose = entry.dispose;
      // `.catch()` only guards against an unhandled promise rejection
      // crashing the process (Node's default `unhandledRejection`
      // policy) — the error itself is swallowed here since this cell
      // has no logging channel of its own. `dispose` implementations
      // must self-handle/self-log their own errors (see the doc
      // comment on `StateCell.set()` in `@crowi/plugin-api`); every
      // driver in this repo already does (e.g. the Elasticsearch
      // plugin's `reconfigure` logs via `ctx.log.warn` inside its own
      // `.catch()`).
      Promise.resolve()
        .then(() => dispose(entry.value))
        .catch(() => {});
    }
  }

  return {
    get: () => current,

    async withValue(fn) {
      const gen = generation;
      const entry = generations.get(gen);
      if (!entry) {
        // Invariant: the live generation's entry is only removed by
        // `maybeDispose`, which never disposes the live generation
        // (`gen === generation` short-circuits it). A missing entry
        // here means that invariant was broken elsewhere.
        throw new Error('state cell: generation missing — internal invariant broken');
      }
      entry.refCount++;
      try {
        return await fn(entry.value);
      } finally {
        entry.refCount--;
        maybeDispose(gen);
      }
    },

    set(next, opts) {
      const prevGen = generation;
      // `prevGen` is always the live generation, whose entry is created
      // either at cell construction (gen 0) or by the previous `set()`
      // call (below) — it can never be missing here.
      const prevEntry = generations.get(prevGen)!;
      prevEntry.dispose = opts?.dispose;
      generation++;
      current = next;
      generations.set(generation, { value: next, refCount: 0 });
      // Runs the dispose immediately (next microtask) when nothing was
      // in flight against the previous generation; otherwise it stays
      // pending until the last in-flight `withValue()` call settles and
      // calls `maybeDispose` itself (see the `finally` above).
      maybeDispose(prevGen);
    },
  };
}
