/**
 * Builds the canonical ID-based share URL for a page (`/<page._id>`).
 *
 * Shared by `LinkSharePopover` and `RestrictedShareBanner` so the URL they
 * advertise and the URL they actually copy can never drift apart — both
 * import this single function instead of each computing it independently.
 *
 * SSR falls back to a root-relative path (no `window` to read the origin
 * from); client renders re-run with the real origin once mounted.
 */
export function buildPageShareUrl(pageId: string): string {
  if (typeof window === 'undefined') return `/${pageId}`;
  return `${window.location.origin}/${pageId}`;
}
