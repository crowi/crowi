import { afterEach, describe, expect, it, vi } from 'vitest';

import { formatHistoryDate } from './date-utils';

afterEach(() => {
  vi.useRealTimers();
});

describe('formatHistoryDate', () => {
  it('shows the time for an entry earlier on the same calendar day', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-26T12:30:00.000Z'));

    expect(formatHistoryDate('2026-08-26T12:09:00.000Z')).toBe('12:09');
  });

  it('shows the date for an entry just across the previous calendar-day boundary', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-26T00:01:00.000Z'));

    expect(formatHistoryDate('2026-08-25T23:59:00.000Z')).toBe('8月25日');
  });

  it('includes the year for an entry outside the current year', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-26T12:30:00.000Z'));

    expect(formatHistoryDate('2025-07-25T12:09:00.000Z')).toBe('2025年7月25日');
  });
});
