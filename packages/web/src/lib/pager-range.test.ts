import { describe, expect, it } from 'vitest';
import { buildPageRange, computePagerWindow } from './pager-range';

describe('buildPageRange', () => {
  it('windows +/- span pages around the current page', () => {
    expect(buildPageRange(5, 10)).toEqual([3, 4, 5, 6, 7]);
  });

  it('clamps the start of the window to 1 near the first page', () => {
    expect(buildPageRange(1, 10)).toEqual([1, 2, 3]);
  });

  it('clamps the end of the window to totalPages near the last page', () => {
    expect(buildPageRange(10, 10)).toEqual([8, 9, 10]);
  });

  it('returns every page when totalPages <= span*2+1', () => {
    expect(buildPageRange(3, 5)).toEqual([1, 2, 3, 4, 5]);
  });

  it('returns a single page when totalPages is 1', () => {
    expect(buildPageRange(1, 1)).toEqual([1]);
  });

  it('honors a custom span', () => {
    expect(buildPageRange(5, 20, 1)).toEqual([4, 5, 6]);
  });
});

describe('computePagerWindow', () => {
  it('shows no dots when the window already touches both edges', () => {
    expect(computePagerWindow(3, 5)).toEqual({ pages: [1, 2, 3, 4, 5], showLeftDots: false, showRightDots: false });
  });

  it('shows only the right dots when the window starts at page 1', () => {
    expect(computePagerWindow(1, 10)).toEqual({ pages: [1, 2, 3], showLeftDots: false, showRightDots: true });
  });

  it('shows only the left dots when the window ends at the last page', () => {
    expect(computePagerWindow(10, 10)).toEqual({ pages: [8, 9, 10], showLeftDots: true, showRightDots: false });
  });

  it('shows both dots when the window is strictly interior', () => {
    expect(computePagerWindow(5, 10)).toEqual({ pages: [3, 4, 5, 6, 7], showLeftDots: true, showRightDots: true });
  });

  it('shows no dots for a single-page total', () => {
    expect(computePagerWindow(1, 1)).toEqual({ pages: [1], showLeftDots: false, showRightDots: false });
  });
});
