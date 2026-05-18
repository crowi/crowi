import { m } from '@paraglide/messages.js';

export function formatDistanceToNow(dateString: string): string {
  const date = new Date(dateString);
  const now = new Date();
  const diffMs = Math.max(0, now.getTime() - date.getTime());

  const diffSecs = Math.floor(diffMs / 1000);
  const diffMins = Math.floor(diffMs / 60_000);
  const diffHours = Math.floor(diffMs / 3_600_000);
  const diffDays = Math.floor(diffMs / 86_400_000);
  const diffWeeks = Math.floor(diffDays / 7);
  const diffMonths = Math.floor(diffDays / 30);
  const diffYears = Math.floor(diffDays / 365);

  if (diffSecs < 60) return m['notifications.relative_seconds']();
  if (diffMins < 60) return m['notifications.relative_minutes']({ count: diffMins });
  if (diffHours < 24) return m['notifications.relative_hours']({ count: diffHours });
  if (diffDays < 7) return m['notifications.relative_days']({ count: diffDays });
  if (diffWeeks < 4) return m['notifications.relative_weeks']({ count: diffWeeks });
  if (diffMonths < 12) return m['notifications.relative_months']({ count: diffMonths });
  return m['notifications.relative_years']({ count: diffYears });
}

/**
 * Format a date string to a localized date string
 */
export function formatDate(dateString: string, options?: Intl.DateTimeFormatOptions): string {
  const date = new Date(dateString);
  return date.toLocaleDateString('en-US', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    ...options,
  });
}

/**
 * Format a date string to a localized date and time string
 */
export function formatDateTime(dateString: string): string {
  const date = new Date(dateString);
  return date.toLocaleString('en-US', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

/**
 * Format a date string to a fixed, locale-independent `YYYY-MM-DD HH:mm`
 * string (e.g. `2026-05-18 11:13`). Used for absolute-datetime tooltips
 * where a stable, compact representation is wanted regardless of locale.
 */
export function formatAbsoluteDateTime(dateString: string): string {
  const date = new Date(dateString);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}
