import type * as Y from 'yjs';

/**
 * Observe a `Y.Text` until a one-shot predicate reports completion, then stop
 * observing — exactly once — with a cleanup that is safe to call whether or not
 * the observer has already self-stopped.
 *
 * `onChange` is invoked immediately once (the warm case, when the content is
 * already present) and then on every `Y.Text` mutation until it returns `true`,
 * at which point the observer removes itself. It may perform a side effect (e.g.
 * placing the caret) before returning `true`.
 *
 * The returned cleanup unobserves **iff** the observer is still registered.
 * Without this guard, an observer that self-removes on success and an effect
 * cleanup that also unobserves would call `yText.unobserve(observer)` twice,
 * which yjs reports as
 * `"[yjs] Tried to remove event handler that doesn't exist."` — the warning
 * seen ~every time the new-page draft flow auto-focuses (the seeded body
 * arrives after mount, so the observer path runs and then the effect re-runs /
 * unmounts).
 *
 * @returns an idempotent cleanup; call it from a `useEffect` cleanup.
 */
export function observeYTextUntil(yText: Y.Text, onChange: () => boolean): () => void {
  // Warm case: already satisfied — never register an observer, so there is
  // nothing to clean up.
  if (onChange()) return () => {};

  let observing = true;
  const stop = (): void => {
    if (!observing) return;
    observing = false;
    yText.unobserve(observer);
  };
  const observer = (): void => {
    if (onChange()) stop();
  };

  yText.observe(observer);
  return stop;
}
