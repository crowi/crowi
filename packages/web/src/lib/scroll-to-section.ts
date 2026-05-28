/**
 * RFC-0005 Phase 3 — smooth-scroll a page section into view and move
 * keyboard focus to its heading, so the comment / backlink meta-chips
 * behave as proper a11y navigation shortcuts (not just visual scrolls).
 *
 * The heading is focused with a transient `tabIndex={-1}` (programmatic
 * focus only — the element does not enter the tab order permanently),
 * and `preventScroll` lets the smooth `scrollIntoView` own the motion.
 */
/**
 * DOM ids of the in-page sections the meta-chips jump to. The heading
 * elements rendered by `page-comments` / `backlink-list` must carry the
 * matching `id`; keeping both sides on these constants prevents the
 * chip target and the heading id from silently drifting apart.
 */
export const SCROLL_TARGETS = {
  COMMENTS: 'comments-heading',
  BACKLINKS: 'backlinks-heading',
} as const;

export function scrollToSection(headingId: string): void {
  if (typeof document === 'undefined') return;

  const heading = document.getElementById(headingId);
  if (!heading) return;

  heading.scrollIntoView({ behavior: 'smooth', block: 'start' });

  // Make the heading programmatically focusable without adding it to the
  // tab order. Cleared on blur so repeated jumps stay idempotent.
  if (!heading.hasAttribute('tabindex')) {
    heading.setAttribute('tabindex', '-1');
    heading.addEventListener(
      'blur',
      () => {
        heading.removeAttribute('tabindex');
      },
      { once: true },
    );
  }
  heading.focus({ preventScroll: true });
}

/**
 * Like `scrollToSection`, but designed for the
 * "I just clicked a deep link, the target may not have rendered yet,
 * and even once it does the page is still reflowing as async sections
 * (comments, attachments, image dimensions) finish loading" case.
 *
 * 1. Try once immediately — covers the warm case where the heading is
 *    already in the DOM.
 * 2. Watch the document with a MutationObserver and re-call
 *    `scrollToSection` on every mutation, so the viewport stays
 *    anchored as the page grows under it.
 * 3. Bail out as soon as the user scrolls (wheel / touch / keyboard)
 *    so we never fight their intent.
 * 4. Otherwise self-disarm after `timeoutMs` (default 5s).
 *
 * Unlike the `useSyncExternalStore` + `hashchange` path that
 * `page-content` uses, this helper does not depend on the URL hash
 * changing — so it works for `router.push`-into-the-same-hash
 * navigations where `hashchange` never fires.
 */
export function scrollToSectionWhenReady(headingId: string, timeoutMs: number = 5_000): void {
  if (typeof document === 'undefined' || typeof window === 'undefined') return;

  let disposed = false;
  let observer: MutationObserver | null = null;
  let settleTimeout: number | null = null;
  let safetyTimeout: number | null = null;
  // Track the heading's absolute Y so we only re-issue `scrollIntoView`
  // when the target actually moved. `html { scroll-behavior: smooth }`
  // (Tailwind `scroll-smooth`) silently upgrades every scroll call to
  // a smooth animation, and re-issuing on each mutation cancels the
  // in-flight animation and restarts it from 0 — so a chatty mutation
  // stream pins the viewport near the top.
  let lastTargetTop = Number.NaN;

  const tryScroll = () => {
    if (disposed) return;
    const target = document.getElementById(headingId);
    if (!target) return;
    const top = Math.round(target.getBoundingClientRect().top + window.scrollY);
    if (top === lastTargetTop) return;
    lastTargetTop = top;
    scrollToSection(headingId);
  };

  const stop = () => {
    if (disposed) return;
    disposed = true;
    observer?.disconnect();
    observer = null;
    if (settleTimeout !== null) window.clearTimeout(settleTimeout);
    settleTimeout = null;
    if (safetyTimeout !== null) window.clearTimeout(safetyTimeout);
    safetyTimeout = null;
  };

  // Refresh the settle timer on every mutation. 500ms of quiet ⇒ the
  // page has stopped reflowing. We intentionally do NOT listen for
  // wheel / touch / keydown — the browser already cancels an in-flight
  // smooth scroll when the user scrolls, and external listeners both
  // misfire on Trackpad inertia events that fire alongside the click
  // (killing the scroll before it ever starts) and add no behaviour
  // the browser doesn't already provide.
  const scheduleSettle = () => {
    if (settleTimeout !== null) window.clearTimeout(settleTimeout);
    settleTimeout = window.setTimeout(stop, 500);
  };

  tryScroll();
  scheduleSettle();

  observer = new MutationObserver(() => {
    tryScroll();
    scheduleSettle();
  });
  observer.observe(document.body, { childList: true, subtree: true });

  safetyTimeout = window.setTimeout(stop, timeoutMs);
}
