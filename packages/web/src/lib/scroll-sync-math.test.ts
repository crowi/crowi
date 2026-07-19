import { describe, it, expect } from 'vitest';
import { SLIDING_REFERENCE_EPSILON, computeScrollProgress, computeSlidingReferenceTarget, isProgressNearEnd, isProgressNearStart } from './scroll-sync-math';

describe('computeScrollProgress', () => {
  it('is 0 at the top of a scrollable pane', () => {
    expect(computeScrollProgress(0, 2000, 500)).toBe(0);
  });

  it('is 1 at the bottom of a scrollable pane', () => {
    expect(computeScrollProgress(1500, 2000, 500)).toBe(1);
  });

  it('is proportional in between', () => {
    // maxScroll = 2000 - 500 = 1500; scrollTop 750 -> 0.5
    expect(computeScrollProgress(750, 2000, 500)).toBeCloseTo(0.5, 10);
  });

  it('clamps overscroll above the max down to 1', () => {
    expect(computeScrollProgress(9999, 2000, 500)).toBe(1);
  });

  it('clamps a negative scrollTop up to 0', () => {
    expect(computeScrollProgress(-10, 2000, 500)).toBe(0);
  });

  it('degenerates to 0 when the pane cannot scroll (scrollHeight === clientHeight)', () => {
    expect(computeScrollProgress(0, 500, 500)).toBe(0);
  });

  it('degenerates to 0 when the pane is shorter than its viewport (scrollHeight < clientHeight)', () => {
    expect(computeScrollProgress(0, 300, 500)).toBe(0);
  });
});

describe('isProgressNearStart / isProgressNearEnd', () => {
  it('treats exactly 0 / 1 as pinned', () => {
    expect(isProgressNearStart(0)).toBe(true);
    expect(isProgressNearEnd(1)).toBe(true);
  });

  it('treats values within epsilon of an endpoint as pinned', () => {
    expect(isProgressNearStart(SLIDING_REFERENCE_EPSILON)).toBe(true);
    expect(isProgressNearEnd(1 - SLIDING_REFERENCE_EPSILON)).toBe(true);
  });

  it('does not pin values clearly inside the range', () => {
    expect(isProgressNearStart(0.5)).toBe(false);
    expect(isProgressNearEnd(0.5)).toBe(false);
    expect(isProgressNearStart(0.1)).toBe(false);
    expect(isProgressNearEnd(0.9)).toBe(false);
  });
});

describe('computeSlidingReferenceTarget', () => {
  const targetViewportHeight = 800;
  const targetMaxScroll = 4000;

  it('pins to 0 at the start regardless of referenceY', () => {
    expect(computeSlidingReferenceTarget({ sourceProgress: 0, referenceY: 12345, targetViewportHeight, targetMaxScroll })).toBe(0);
  });

  it('pins to 0 near (but not exactly at) the start', () => {
    expect(
      computeSlidingReferenceTarget({
        sourceProgress: SLIDING_REFERENCE_EPSILON,
        referenceY: 999,
        targetViewportHeight,
        targetMaxScroll,
      }),
    ).toBe(0);
  });

  it('pins to targetMaxScroll at the end regardless of referenceY', () => {
    expect(computeSlidingReferenceTarget({ sourceProgress: 1, referenceY: 0, targetViewportHeight, targetMaxScroll })).toBe(targetMaxScroll);
  });

  it('pins to targetMaxScroll near (but not exactly at) the end', () => {
    expect(
      computeSlidingReferenceTarget({
        sourceProgress: 1 - SLIDING_REFERENCE_EPSILON,
        referenceY: 0,
        targetViewportHeight,
        targetMaxScroll,
      }),
    ).toBe(targetMaxScroll);
  });

  it('returns null when referenceY is unresolved and progress is interior (no anchors yet)', () => {
    expect(computeSlidingReferenceTarget({ sourceProgress: 0.5, referenceY: null, targetViewportHeight, targetMaxScroll })).toBeNull();
  });

  it('at p=0 aligns the reference point at the target viewport TOP (top-aligned regression)', () => {
    // referenceY IS the target scrollTop when the alignment fraction is 0.
    const referenceY = 1200;
    const target = computeSlidingReferenceTarget({ sourceProgress: 0, referenceY, targetViewportHeight, targetMaxScroll });
    expect(target).toBe(0);
    // Sanity: at p=0 the pin short-circuits before even looking at
    // referenceY, so the "aligned at top" property holds trivially — this
    // is the documented degeneration back to legacy top-alignment.
  });

  it('at p=0.5 aligns the reference point at the target viewport CENTER', () => {
    const referenceY = 2200; // content-space y of the reference line in the target pane
    const target = computeSlidingReferenceTarget({ sourceProgress: 0.5, referenceY, targetViewportHeight, targetMaxScroll });
    // target scrollTop such that referenceY appears at 0.5 * viewportHeight from the top:
    // referenceY - target === 0.5 * targetViewportHeight
    expect(target).not.toBeNull();
    expect(referenceY - (target as number)).toBeCloseTo(0.5 * targetViewportHeight, 10);
  });

  it('places the reference point at the SAME proportional height as sourceProgress for arbitrary p', () => {
    for (const p of [0.1, 0.25, 0.42, 0.73, 0.9]) {
      const referenceY = 3000;
      const target = computeSlidingReferenceTarget({ sourceProgress: p, referenceY, targetViewportHeight, targetMaxScroll });
      expect(target).not.toBeNull();
      expect(referenceY - (target as number)).toBeCloseTo(p * targetViewportHeight, 10);
    }
  });

  it('clamps an interior result below 0', () => {
    // referenceY near the very top of the content, at a mid progress: raw
    // target would go negative.
    const target = computeSlidingReferenceTarget({
      sourceProgress: 0.5,
      referenceY: 10,
      targetViewportHeight,
      targetMaxScroll,
    });
    expect(target).toBe(0);
  });

  it('clamps an interior result above targetMaxScroll', () => {
    const target = computeSlidingReferenceTarget({
      sourceProgress: 0.5,
      referenceY: 100000,
      targetViewportHeight,
      targetMaxScroll,
    });
    expect(target).toBe(targetMaxScroll);
  });

  it('produces a monotonic, bounded-delta sequence as sourceProgress sweeps 0 -> 1 (no discontinuous jump)', () => {
    // Simulate a plausible document: the reference point's content-space y
    // grows linearly with progress (a reasonable approximation for a long,
    // evenly-anchored document), spanning well past the target's own
    // scrollable range so clamping doesn't flatten the whole sweep.
    const contentSpan = 20000;
    const referenceYAt = (p: number) => p * contentSpan;

    const STEP = 0.001;
    let prev = computeSlidingReferenceTarget({
      sourceProgress: 0,
      referenceY: referenceYAt(0),
      targetViewportHeight,
      targetMaxScroll,
    });
    expect(prev).not.toBeNull();

    // Upper bound on the per-step delta. Away from the pin boundaries this
    // is `STEP * contentSpan` (referenceY's growth) plus `STEP *
    // targetViewportHeight` (the alignment fraction shifting the opposite
    // way). Right at the pin boundary (p crossing `SLIDING_REFERENCE_EPSILON`
    // or `1 - SLIDING_REFERENCE_EPSILON`) the pinned side contributes a flat
    // `0` / `targetMaxScroll` instead of following the linear formula, so
    // the very next interior sample has to "catch up" the distance the pin
    // absorbed too — bounded by one extra `SLIDING_REFERENCE_EPSILON` worth
    // of the same slope. This is the intentional, epsilon-scaled (hence
    // imperceptibly small in practice) trade-off documented on
    // `computeSlidingReferenceTarget`, not an unbounded discontinuity.
    const maxStepDelta = (STEP + SLIDING_REFERENCE_EPSILON) * (contentSpan + targetViewportHeight) + 1;

    let sawIncrease = false;
    for (let p = STEP; p <= 1 + 1e-9; p += STEP) {
      const clampedP = Math.min(1, p);
      const current = computeSlidingReferenceTarget({
        sourceProgress: clampedP,
        referenceY: referenceYAt(clampedP),
        targetViewportHeight,
        targetMaxScroll,
      });
      expect(current).not.toBeNull();
      const cur = current as number;
      const pr = prev as number;
      // Monotonic (content-space y grows with p faster than the alignment
      // fraction subtracts, for this contentSpan/viewportHeight ratio).
      expect(cur).toBeGreaterThanOrEqual(pr - 1e-9);
      if (cur > pr) sawIncrease = true;
      // Bounded, continuous step-to-step delta — this is what rules out a
      // "jump" at the pin/interior boundary (p=epsilon, p=1-epsilon).
      expect(Math.abs(cur - pr)).toBeLessThanOrEqual(maxStepDelta);
      prev = current;
    }
    expect(sawIncrease).toBe(true);
    expect(prev).toBe(targetMaxScroll);
  });
});
