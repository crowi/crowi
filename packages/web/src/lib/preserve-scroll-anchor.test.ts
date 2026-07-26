import { describe, expect, it, vi } from 'vitest';
import { applyScrollCompensation, computeScrollCompensation, measureSlot, shouldCompensate } from './preserve-scroll-anchor';

describe('measureSlot', () => {
  it('reads the viewport-relative top and bottom edges off getBoundingClientRect', () => {
    const el = { getBoundingClientRect: () => ({ top: -240, bottom: -144 }) } as unknown as Element;
    expect(measureSlot(el)).toEqual({ top: -240, bottom: -144 });
  });
});

describe('computeScrollCompensation', () => {
  it('is positive when the slot pushed the body down (no native scroll anchoring)', () => {
    expect(computeScrollCompensation({ top: -100, bottom: -100 }, { top: -100, bottom: -20 })).toBe(80);
  });

  it('is negative when the slot pulled the body up', () => {
    expect(computeScrollCompensation({ top: -100, bottom: -20 }, { top: -100, bottom: -100 })).toBe(-80);
  });

  it('is zero when the engine already scroll-anchored the change away', () => {
    // Blink/Gecko shift the scroll offset themselves, so the slot's top
    // edge moves instead of its bottom edge. Compensating again here would
    // double-correct and throw the reader the other way.
    expect(computeScrollCompensation({ top: -100, bottom: -100 }, { top: -180, bottom: -100 })).toBe(0);
  });
});

describe('shouldCompensate', () => {
  const viewportHeight = 800;

  it('is true when the reader has scrolled past the slot entirely', () => {
    expect(shouldCompensate(-240, 40, viewportHeight)).toBe(true);
  });

  it('is true when the slot is only PARTLY visible — the body text below it still shifts', () => {
    // Regression guard: an intersecting slot used to skip compensation,
    // which let the paragraph the reader was on jump by the slot delta.
    expect(shouldCompensate(-20, 40, viewportHeight)).toBe(true);
  });

  it('is true when the slot is fully visible but body content below it is on screen', () => {
    expect(shouldCompensate(100, 40, viewportHeight)).toBe(true);
  });

  it('is true at the very top of the document (top === 0)', () => {
    expect(shouldCompensate(0, 40, viewportHeight)).toBe(true);
  });

  it('is false when the slot starts at or below the fold — nothing on screen moves', () => {
    expect(shouldCompensate(800, 40, viewportHeight)).toBe(false);
    expect(shouldCompensate(850, 40, viewportHeight)).toBe(false);
  });

  it('is false for a sub-pixel delta', () => {
    expect(shouldCompensate(-240, 0.4, viewportHeight)).toBe(false);
  });

  it('is false for a zero delta', () => {
    expect(shouldCompensate(-240, 0, viewportHeight)).toBe(false);
  });
});

describe('applyScrollCompensation', () => {
  it('calls the injected scrollBy with (0, delta)', () => {
    const scrollBy = vi.fn();
    applyScrollCompensation(42, scrollBy);
    expect(scrollBy).toHaveBeenCalledWith(0, 42);
  });

  it('defaults to window.scrollBy when no override is given', () => {
    const spy = vi.spyOn(window, 'scrollBy').mockImplementation(() => {});
    applyScrollCompensation(-16);
    expect(spy).toHaveBeenCalledWith(0, -16);
    spy.mockRestore();
  });
});
