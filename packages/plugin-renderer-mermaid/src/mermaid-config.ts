/**
 * spec §1 layer 1 — the host-forced Mermaid config, applied exactly
 * once at worker startup and never overridable per-call (§1: "呼び出し
 * ごとの引数では変更できない"). Mirrors Phase 0's
 * `__fixtures__/spike-worker.ts` config, which is what the compatibility
 * gates (§8) were actually validated against.
 *
 * `gantt.useWidth` (regression fix): the Gantt renderer reads
 * `elem.parentElement.offsetWidth` to size the chart
 * (`ganttDiagram-*.mjs`'s `draw()`), falling back to `1200` only when
 * that read is `undefined` — but jsdom's `offsetWidth` (no real layout
 * engine) always returns `0`, not `undefined`, so that fallback never
 * fires and every Gantt chart gets laid out against a 0px budget,
 * producing a negative-width/zero-`viewBox` SVG that fails to render.
 * `useWidth` is Mermaid's own documented escape hatch for exactly this
 * ("no real container to measure") case — set it to the same `1200`
 * Mermaid's own fallback intended.
 *
 * `layout` / `look` are pinned because Mermaid 12 otherwise lays diagrams out with
 * ELK and (with `theme: 'base'`) styles nodes with the neo look, which would
 * silently change the placement and colors of every existing wiki diagram.
 */
export const MERMAID_INIT_CONFIG = {
  startOnLoad: false,
  securityLevel: 'strict',
  htmlLabels: false,
  flowchart: { htmlLabels: false },
  gantt: { useWidth: 1200 },
  theme: 'base',
  layout: 'dagre',
  look: 'classic',
} as const;
