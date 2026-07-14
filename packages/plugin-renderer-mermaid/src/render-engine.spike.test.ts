/**
 * Phase 0 gate A — diagram correctness
 * (.feature-state/specs/feature-plugin-renderer-mermaid.md §8 A).
 *
 * Candidate: `mermaid` (official package), run headless via `jsdom` +
 * a `getBBox()` polyfill (see __fixtures__/mermaid-dom-env.ts for why
 * jsdom alone isn't enough). The candidate runs inside a forked worker
 * process (__fixtures__/spike-worker.ts) rather than in-process — see
 * __fixtures__/spike-protocol.ts for why (mermaid/jsdom's ESM-only
 * transitive dependencies don't load through Jest's CJS module registry).
 *
 * For all 8 diagram types in the corpus (flowchart / sequence / class /
 * state / ER / journey / pie / git-graph), this verifies the 4 conditions
 * §8 A requires:
 *   1. `mermaid.render()` completes without throwing.
 *   2. The returned string is well-formed XML with a single root `<svg>`.
 *   3. Text labels are uniquely dispersed: not all collapsed on top of
 *      each other at/near the origin (the classic symptom of a
 *      `getBBox()` failure), AND no two labels sit at the exact same
 *      coordinate (which a pure "average spread" metric alone would miss
 *      — a diagram where most labels are dispersed but two are pinned to
 *      the same point would still pass an RMS-only check).
 *   4. Each render completes within a documented time budget.
 *
 * §8's own fallback rule applies here: if any diagram type fails any of
 * these 4 conditions, do not silently accept it — switch to Approach B
 * (headless browser) per §8's "Phase 0が失敗した場合の扱い". As of this
 * commit, all 8 pass; see the "Phase 0 findings" block at the bottom of
 * this file for what that run observed and what it means for Phase 1.
 */

import { DIAGRAM_CORPUS } from './__fixtures__/diagram-corpus';
import { forkSpikeWorker, type SpikeWorker } from './__fixtures__/fork-spike-worker';

/**
 * §8 A-4's "目安2秒" guideline, with an explicit CI margin. Local runs of
 * this suite complete every corpus entry in well under 300ms (`pie` is
 * the fastest, `flowchart`/`state` the slowest at ~150-300ms) — the 2s
 * guideline itself already has generous headroom locally. CI shared
 * runners can be several times slower under contention, so the budget
 * below is ~2.5x the spec's guideline rather than the raw 2s, to avoid a
 * flaky gate while still catching a genuine hang/regression (a runaway
 * render would take seconds-to-never, not "2.1s vs 2.0s").
 */
const RENDER_TIME_BUDGET_MS = 5_000;

/** RMS distance of `positions` from their centroid. */
function spreadOf(positions: ReadonlyArray<{ x: number; y: number }>): number {
  if (positions.length < 2) return 0;
  const cx = positions.reduce((sum, p) => sum + p.x, 0) / positions.length;
  const cy = positions.reduce((sum, p) => sum + p.y, 0) / positions.length;
  const sumSq = positions.reduce((sum, p) => sum + (p.x - cx) ** 2 + (p.y - cy) ** 2, 0);
  return Math.sqrt(sumSq / positions.length);
}

/**
 * Coordinates that collide (to within 1 decimal place, i.e. sub-pixel) once
 * rounded. An RMS-spread check alone tolerates this: e.g. 7 well-dispersed
 * labels plus 1 pair pinned to the same point still produces a healthy
 * overall spread. §8 A-3 requires each label's position to be unique, so
 * this is checked directly instead of only inferred from an aggregate
 * statistic.
 */
function duplicateCoordinates(positions: ReadonlyArray<{ x: number; y: number }>): string[] {
  const seen = new Map<string, number>();
  for (const p of positions) {
    const key = `${Math.round(p.x * 10) / 10},${Math.round(p.y * 10) / 10}`;
    seen.set(key, (seen.get(key) ?? 0) + 1);
  }
  return [...seen.entries()].filter(([, count]) => count > 1).map(([key]) => key);
}

describe('Phase 0 gate A: 8-diagram-type correctness (mermaid + jsdom)', () => {
  let worker: SpikeWorker;
  let nextId = 1;

  beforeAll(async () => {
    worker = await forkSpikeWorker();
  }, 30_000);

  afterAll(() => {
    worker?.kill();
  });

  it.each(
    DIAGRAM_CORPUS.map((entry) => [entry.name, entry.source] as const),
  )('%s renders without throwing, produces a well-formed single-root <svg>, disperses label coordinates, and stays within budget', async (name, source) => {
    const start = Date.now();
    const result = await worker.render({ id: nextId++, source });
    const elapsedMs = Date.now() - start;

    // Condition 1: no exception.
    if (!result.ok) {
      throw new Error(`${name} failed to render: ${result.error}`);
    }

    // Condition 2: well-formed single-root <svg>.
    expect(result.isWellFormedSingleRootSvg).toBe(true);

    // Condition 3: labels not collapsed at/near the origin, and — beyond
    // the aggregate spread — no two labels sit at the exact same
    // coordinate (a duplicate-coordinate pair would otherwise hide inside
    // a healthy-looking RMS spread computed over the rest of the labels).
    expect(result.labelPositions.length).toBeGreaterThan(0);
    const allNearOrigin = result.labelPositions.every((p) => Math.abs(p.x) < 3 && Math.abs(p.y) < 3);
    expect(allNearOrigin).toBe(false);
    if (result.labelPositions.length > 1) {
      expect(spreadOf(result.labelPositions)).toBeGreaterThan(1);
      expect(duplicateCoordinates(result.labelPositions)).toEqual([]);
    }

    // Condition 4: within the time budget (see rationale above).
    expect(elapsedMs).toBeLessThan(RENDER_TIME_BUDGET_MS);
  });
});

/**
 * Phase 0 findings (recorded here per architecturalNotes — no separate
 * *.md artifact): mermaid@11 + jsdom@29 clears gate A for all 8 corpus
 * diagram types on Node 24, on the condition that `SVGElement#getBBox` is
 * polyfilled (jsdom does not implement SVG layout at all — every call
 * throws "not implemented" without the polyfill in
 * __fixtures__/mermaid-dom-env.ts). A naive polyfill (bbox purely from
 * `textContent.length`, applied uniformly to every element including
 * containers) also clears this gate's mechanical checks but produces a
 * wildly wrong final viewBox (~31,000px wide for a 2-node flowchart,
 * because the root `<svg>`'s own `textContent` includes the injected
 * `<style>` block). The geometry-aware polyfill actually used here avoids
 * that: the same 2-node flowchart comes out with a ~100x200 viewBox.
 * Phase 1's real `render-worker.ts` should reuse (a hardened version of)
 * this polyfill rather than reinvent it.
 *
 * A second finding surfaced while hardening condition 3 into a strict
 * per-label uniqueness check (not just an aggregate spread): mermaid emits
 * an empty `<text><tspan .../></text>` placeholder for every *unlabeled*
 * edge (e.g. `stateDiagram-v2`'s `[*] --> Still`), and every one of these
 * placeholders — by construction, not a rendering defect — shares one
 * identical, never-laid-out coordinate. `stateDiagram-v2`'s 5-transition
 * corpus entry has 5 such placeholders alongside its 3 real state-name
 * labels; treating the placeholders as "labels" would make a correct
 * render fail a strict duplicate-coordinate check. `extractLabelPositions`
 * (__fixtures__/svg-inspect.ts) filters `<text>` elements with empty
 * `textContent` out before returning label positions for exactly this
 * reason. Phase 1's render output inspection (if any is added, e.g. for a
 * `<title>`/alt-text derivation per §9) should apply the same filter.
 */
