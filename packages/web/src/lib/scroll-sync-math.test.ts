import { describe, expect, it } from 'vitest';
import {
  computeDensityCompensatedReferenceTarget,
  computeScrollProgress,
  computeSlidingReferenceTarget,
  isProgressNearEnd,
  isProgressNearStart,
  SLIDING_REFERENCE_EPSILON,
  type SlidingReferenceTargetInput,
} from './scroll-sync-math';

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

  it('does not return NaN when the target viewport is momentarily zero-height (e.g. mid layout transition)', () => {
    const target = computeSlidingReferenceTarget({
      sourceProgress: 0.5,
      referenceY: 100,
      targetViewportHeight: 0,
      targetMaxScroll: 1000,
    });
    expect(target).not.toBeNaN();
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

describe('computeSlidingReferenceTarget equivalence with its pre-refactor formula', () => {
  // `computeSlidingReferenceTarget` now delegates to
  // `computeDensityCompensatedReferenceTarget` with
  // `topReferenceY = bottomReferenceY = referenceY` (see
  // `.feature-state/specs/feature-scroll-sync-math-dedup.md`). This is the
  // exact formula it used to compute directly, kept here only as a
  // reference implementation so a regression in the delegation (or a future
  // divergence between the two functions' endpoint-pin/clamp shells) shows
  // up as a mismatch instead of silently changing behaviour.
  function referenceComputeSlidingReferenceTarget({
    sourceProgress,
    referenceY,
    targetViewportHeight,
    targetMaxScroll,
  }: SlidingReferenceTargetInput): number | null {
    if (isProgressNearStart(sourceProgress)) return 0;
    if (isProgressNearEnd(sourceProgress)) return targetMaxScroll;
    if (referenceY === null) return null;
    const raw = referenceY - sourceProgress * targetViewportHeight;
    return Math.max(0, Math.min(targetMaxScroll, raw));
  }

  // sourceProgress: interior values, the pin thresholds themselves, values
  // just inside/outside each threshold, and the hard 0/1 endpoints.
  const sourceProgresses = [
    0,
    SLIDING_REFERENCE_EPSILON / 2,
    SLIDING_REFERENCE_EPSILON,
    SLIDING_REFERENCE_EPSILON * 1.5,
    0.01,
    0.25,
    0.5,
    0.73,
    0.99,
    1 - SLIDING_REFERENCE_EPSILON * 1.5,
    1 - SLIDING_REFERENCE_EPSILON,
    1 - SLIDING_REFERENCE_EPSILON / 2,
    1,
  ];
  // referenceY: positive / negative / zero, plus null (the unresolved-anchor
  // case — this is what pins down the null-guard equivalence).
  const referenceYs: Array<number | null> = [-500, -1, 0, 1, 250, 1200, 10000, null];
  // Representative target-pane dimensions, including the targetMaxScroll = 0
  // degenerate case (a target pane that cannot scroll at all).
  const dims = [
    { targetViewportHeight: 800, targetMaxScroll: 4000 },
    { targetViewportHeight: 800, targetMaxScroll: 0 },
    { targetViewportHeight: 500, targetMaxScroll: 100 },
    { targetViewportHeight: 300, targetMaxScroll: 5000 },
  ];

  it('matches the pre-refactor formula exactly across sourceProgress x referenceY x target-dimension combinations, including the null-referenceY guard at interior progress', () => {
    for (const sourceProgress of sourceProgresses) {
      for (const referenceY of referenceYs) {
        for (const { targetViewportHeight, targetMaxScroll } of dims) {
          const input = { sourceProgress, referenceY, targetViewportHeight, targetMaxScroll };
          expect(computeSlidingReferenceTarget(input)).toBe(referenceComputeSlidingReferenceTarget(input));
        }
      }
    }
  });

  it('returns exactly null (never a number) when referenceY is null at an interior progress', () => {
    // Standalone assertion for the null-guard equivalence beyond the
    // combinatorial loop above: sliding's `referenceY === null` guard and
    // density-compensated's `topReferenceY === null || bottomReferenceY ===
    // null` guard collapse to the same branch once both edges receive the
    // same value.
    expect(computeSlidingReferenceTarget({ sourceProgress: 0.42, referenceY: null, targetViewportHeight: 800, targetMaxScroll: 4000 })).toBeNull();
  });

  it('matches the pre-refactor formula exactly for a non-round-number input that previously exposed floating-point interpolation drift', () => {
    // Regression for a case caught by review: with topReferenceY ===
    // bottomReferenceY === referenceY, the density-compensated delegate used
    // to recompute `referenceY` via `(1 - p) * Y + p * Y`, which does not
    // always round-trip back to exactly `Y` in IEEE 754 arithmetic. That
    // diverged from the pre-refactor formula (which used `referenceY`
    // directly, no interpolation) by an ULP-scale amount for some inputs —
    // undetectable via the round-number grid above, but real.
    const input = {
      sourceProgress: 0.38415338408277877,
      referenceY: 3696.330127969984,
      targetViewportHeight: 1081.9123146890065,
      targetMaxScroll: 20000,
    };
    expect(computeSlidingReferenceTarget(input)).toBe(referenceComputeSlidingReferenceTarget(input));
    expect(computeSlidingReferenceTarget(input)).toBe(3280.7098510013698);
  });

  it('matches the pre-refactor formula exactly across a large sample of pseudo-random non-round-number inputs', () => {
    // Deterministic PRNG (mulberry32) so a failure is reproducible without
    // relying on a fixed grid of round numbers, which is exactly the kind of
    // input the regression above slipped through on.
    function mulberry32(seed: number): () => number {
      let state = seed;
      return () => {
        state = (state + 0x6d2b79f5) | 0;
        let t = state;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
      };
    }

    const random = mulberry32(0x5c001a1);
    const SAMPLE_COUNT = 2000;
    for (let i = 0; i < SAMPLE_COUNT; i++) {
      // Bias roughly a quarter of samples into the pin zones so both the
      // interior formula and the endpoint pins get non-round-number coverage.
      const sourceProgress = random() < 0.25 ? random() * SLIDING_REFERENCE_EPSILON * 3 : random();
      const referenceY = (random() - 0.5) * 20000;
      const targetViewportHeight = random() * 2000 + 1;
      // Occasionally exercise the targetMaxScroll = 0 degenerate case.
      const targetMaxScroll = random() < 0.1 ? 0 : random() * 20000;
      const input = { sourceProgress, referenceY, targetViewportHeight, targetMaxScroll };
      expect(computeSlidingReferenceTarget(input)).toBe(referenceComputeSlidingReferenceTarget(input));
    }
  });
});

describe('computeDensityCompensatedReferenceTarget', () => {
  const targetViewportHeight = 800;
  const targetMaxScroll = 11200;

  it('keeps a denser preview viewport bottom visible at an interior progress', () => {
    const target = computeDensityCompensatedReferenceTarget({
      sourceProgress: 0.8,
      topReferenceY: 2936,
      bottomReferenceY: 4048,
      targetViewportHeight,
      targetMaxScroll,
    });

    expect(target).toBe(3248);
    expect((target as number) + targetViewportHeight).toBe(4048);
  });

  it('matches the sliding-reference placement when both viewports have equal density', () => {
    const target = computeDensityCompensatedReferenceTarget({
      sourceProgress: 0.5,
      topReferenceY: 2000,
      bottomReferenceY: 2800,
      targetViewportHeight,
      targetMaxScroll,
    });

    expect(target).toBe(2000);
  });

  it('pins endpoints without requiring resolved edge references', () => {
    expect(
      computeDensityCompensatedReferenceTarget({
        sourceProgress: 0,
        topReferenceY: null,
        bottomReferenceY: null,
        targetViewportHeight,
        targetMaxScroll,
      }),
    ).toBe(0);
    expect(
      computeDensityCompensatedReferenceTarget({
        sourceProgress: 1,
        topReferenceY: null,
        bottomReferenceY: null,
        targetViewportHeight,
        targetMaxScroll,
      }),
    ).toBe(targetMaxScroll);
  });

  it('returns null when an interior edge reference is unresolved', () => {
    expect(
      computeDensityCompensatedReferenceTarget({
        sourceProgress: 0.8,
        topReferenceY: 2936,
        bottomReferenceY: null,
        targetViewportHeight,
        targetMaxScroll,
      }),
    ).toBeNull();
  });
});
