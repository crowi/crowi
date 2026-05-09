/**
 * Relative-date formatter shared by `PageListItem` and `SearchHitItem`.
 *
 * Returns a short human-readable string ("just now", "5m ago", "3d ago") for
 * recent timestamps and falls back to a localised `MMM D` for anything older
 * than a week. Kept intentionally minimal — for richer formatting (years,
 * months) see `formatDistanceToNow` in `@/lib/date-utils`.
 */
export function formatRelativeDate(dateString: string): string {
  const date = new Date(dateString);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffMins = Math.floor(diffMs / 60000);
  const diffHours = Math.floor(diffMs / 3600000);
  const diffDays = Math.floor(diffMs / 86400000);

  if (diffMins < 1) return 'just now';
  if (diffMins < 60) return `${diffMins}m ago`;
  if (diffHours < 24) return `${diffHours}h ago`;
  if (diffDays < 7) return `${diffDays}d ago`;
  return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}
