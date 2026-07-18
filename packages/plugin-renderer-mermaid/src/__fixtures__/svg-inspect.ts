/**
 * §8 A-2/A-3 machine checks, run inside spike-worker.ts right after a
 * render (it already has jsdom's `DOMParser` installed by
 * mermaid-dom-env.ts — no separate parser needed).
 */

import { parseTranslate } from './parse-translate.ts';
import type { LabelPosition } from './spike-protocol.ts';

/**
 * §8 A-2: "well-formed XML with a single root `<svg>`". Parses via
 * `DOMParser` (real XML parsing, not a regex heuristic) and checks for
 * jsdom's `parsererror` marker plus a single `<svg>` document element.
 */
export function isWellFormedSingleRootSvg(svg: string): boolean {
  const parser = new DOMParser();
  const doc = parser.parseFromString(svg, 'image/svg+xml');
  if (doc.getElementsByTagName('parsererror').length > 0) return false;
  if (doc.documentElement.tagName !== 'svg') return false;
  // A well-formed XML document has exactly one root element. jsdom's
  // DOMParser only ever exposes a single `documentElement`, so the
  // meaningful check beyond "no parsererror" is that nothing else sits
  // alongside it at the document level (e.g. no second top-level element
  // smuggled in after a premature `</svg>` close).
  return doc.childNodes.length === 1;
}

/**
 * §8 A-3: extracts an approximate absolute position for every `<text>`
 * label in the rendered SVG, by walking each text element's ancestor
 * chain and summing `transform="translate(dx,dy)"` offsets — this
 * candidate positions node/edge labels via a `<g transform="translate(...)">`
 * wrapper rather than `x`/`y` on the `<text>` itself (confirmed by
 * inspecting actual output), so the ancestor walk is the meaningful
 * signal, with the text element's own `x`/`y` folded in for completeness.
 *
 * Skips `<text>` elements with empty (whitespace-only) `textContent`:
 * mermaid emits an empty `<text><tspan .../></text>` placeholder for every
 * *unlabeled* edge (confirmed by inspecting actual output for e.g.
 * `stateDiagram-v2`'s `[*] --> Still`) and these placeholders are — by
 * construction, not by a rendering defect — never laid out and legitimately
 * share one identical position across a diagram. They are not "labels" in
 * §8 A-3's sense (there is no visible text to be dispersed), and including
 * them would make the dispersion check below reject correct output.
 */
export function extractLabelPositions(svg: string): LabelPosition[] {
  const parser = new DOMParser();
  const doc = parser.parseFromString(svg, 'image/svg+xml');
  const texts = Array.from(doc.getElementsByTagName('text')).filter((text) => (text.textContent ?? '').trim().length > 0);
  return texts.map((text) => {
    let x = Number.parseFloat(text.getAttribute('x') ?? '0') || 0;
    let y = Number.parseFloat(text.getAttribute('y') ?? '0') || 0;
    let node: Element | null = text;
    while (node) {
      const { dx, dy } = parseTranslate(node);
      x += dx;
      y += dy;
      node = node.parentElement;
    }
    return { x, y };
  });
}
