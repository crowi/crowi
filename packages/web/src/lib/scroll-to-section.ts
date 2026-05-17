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
