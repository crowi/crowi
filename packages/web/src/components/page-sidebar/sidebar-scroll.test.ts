import { describe, expect, it } from 'vitest';
import { scrollOffsetToCenter } from './sidebar-scroll';

describe('scrollOffsetToCenter', () => {
  // A 400px-tall rail starting 100px down the viewport.
  const view = { top: 100, bottom: 500, height: 400 };
  const row = (top: number) => ({ top, bottom: top + 20, height: 20 });

  it('does not move when the row is already fully visible', () => {
    expect(scrollOffsetToCenter(row(100), view)).toBe(0);
    expect(scrollOffsetToCenter(row(300), view)).toBe(0);
    // Flush against the bottom edge still counts as visible.
    expect(scrollOffsetToCenter(row(480), view)).toBe(0);
  });

  it('scrolls down to centre a row below the fold', () => {
    // 190px past the top of the rail, minus the 190px that centres it.
    expect(scrollOffsetToCenter(row(800), view)).toBe(510);
  });

  it('scrolls up (negative) to centre a row above the fold', () => {
    expect(scrollOffsetToCenter(row(0), view)).toBe(-290);
  });

  it('treats a row that overflows only its bottom edge as off-screen', () => {
    // 495..515 — the tail is clipped, so it is worth a jump.
    expect(scrollOffsetToCenter(row(495), view)).toBe(205);
  });
});
