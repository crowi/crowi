/**
 * When this document last received the reader's own input.
 *
 * A click or key press inside a cross-origin frame never dispatches an input
 * event here, yet it still leaves a transient user activation on this
 * document. So a live activation while this document has been quiet for
 * longer than an activation lives can only have come from inside a frame.
 * An artifact page uses that to tell a link activated inside the artifact
 * apart from the activation left over by the click that brought the reader
 * to the page — an artifact's script can pull this document's focus into its
 * frame on load, so focus alone does not tell them apart.
 */

/**
 * Longer than the transient activation lifetime of the engines Crowi
 * supports (5 seconds in Chromium and Firefox), so a live activation is never
 * older than the quiet period that vouches for it.
 */
export const PARENT_INPUT_QUARANTINE_MS = 6000;

// Wider than the events that grant an activation: an extra event type only
// ever withholds a direct navigation, never permits one.
const INPUT_EVENT_TYPES = ['pointerdown', 'pointerup', 'mousedown', 'mouseup', 'keydown', 'keyup', 'touchstart', 'touchend', 'click'] as const;

let installedListener: ((event: Event) => void) | null = null;
let lastInputAt: number | null = null;

export function installParentInputClock(options: { trust?: (event: Event) => boolean } = {}): void {
  if (installedListener || typeof window === 'undefined') return;
  const trust = options.trust ?? ((event: Event) => event.isTrusted);
  const listener = (event: Event) => {
    if (trust(event)) lastInputAt = performance.now();
  };
  // Capture on window runs before any handler in the page could stop the event.
  for (const type of INPUT_EVENT_TYPES) window.addEventListener(type, listener, { capture: true, passive: true });
  installedListener = listener;
}

/** False until the clock is installed: an unobserved document cannot vouch for being quiet. */
export function isParentInputQuiet(now: number = performance.now()): boolean {
  if (!installedListener) return false;
  return lastInputAt === null || now - lastInputAt >= PARENT_INPUT_QUARANTINE_MS;
}

export function resetParentInputClockForTest(): void {
  if (installedListener) {
    for (const type of INPUT_EVENT_TYPES) window.removeEventListener(type, installedListener, { capture: true });
  }
  installedListener = null;
  lastInputAt = null;
}
