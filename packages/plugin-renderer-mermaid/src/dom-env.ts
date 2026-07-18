/**
 * Production DOM env installer for the Mermaid render worker (spec §10
 * (a): "選定したDOMアダプタ(JSDOM等)を、リソースローダを無効化した構成で
 * 明示的に初期化する"). Hardened port of Phase 0's
 * `__fixtures__/mermaid-dom-env.ts` — same `getBBox`/`getComputedTextLength`
 * polyfill (Phase 0's doc comment on that file names this exact
 * production port as the intended next step: "a production
 * render-worker.ts in Phase 1 should reuse (a hardened version of) the
 * geometry-aware polyfill below"), with one behavioural change: the
 * `JSDOM` constructor call below passes `resources: undefined` and does
 * NOT set `runScripts` explicitly, as production code, not "the
 * defaults happened to be safe" — jsdom's actual default behaviour is
 * unchanged (external resource loading and script execution are already
 * off by default), but writing the options down turns "safe by
 * omission" into "safe by an explicit, reviewable decision" (the exact
 * distinction spec §10 (a) draws).
 */

import { JSDOM } from 'jsdom';

// jsdom exposes non-configurable getters for a few names (`navigator`,
// `location`, ...) directly on the *global* `EventTarget`-like object;
// copying every own property from `window` to `globalThis` blindly throws
// on those, so they get an explicit `defineProperty` below instead.
// `window`/`self`/`top`/`parent`/`frames` are self-referential on the
// jsdom `window` and must not shadow `globalThis` under those names.
const SELF_REFERENTIAL_KEYS = new Set(['window', 'self', 'top', 'parent', 'frames']);

let installed = false;

/** Idempotent — safe to call once at worker startup. */
export function installMermaidDomEnv(): void {
  if (installed) return;
  installed = true;

  const dom = new JSDOM('<!DOCTYPE html><html><body></body></html>', {
    pretendToBeVisual: true,
    // Explicit deny-by-default (spec §10 (a)) — no external resource
    // loading (stylesheets / images / frames / scripts-via-src), no
    // script execution of any kind.
    resources: undefined,
  });
  const { window } = dom;

  for (const key of Object.getOwnPropertyNames(window)) {
    if (SELF_REFERENTIAL_KEYS.has(key)) continue;
    if (key in globalThis) continue;
    try {
      Object.defineProperty(globalThis, key, {
        value: (window as unknown as Record<string, unknown>)[key],
        configurable: true,
        writable: true,
      });
    } catch {
      // A handful of jsdom's `window` own-properties are non-configurable
      // getters; skipping them is fine — mermaid never touches them, and
      // the explicit defineProperty calls below cover what it does need.
    }
  }

  Object.defineProperty(globalThis, 'window', { value: window, configurable: true, writable: true });
  Object.defineProperty(globalThis, 'navigator', { value: window.navigator, configurable: true, writable: true });
  Object.defineProperty(globalThis, 'document', { value: window.document, configurable: true, writable: true });

  installGetBBoxPolyfill(window);
}

interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

function installGetBBoxPolyfill(window: JSDOM['window']): void {
  const svgProto = window.SVGElement.prototype as unknown as {
    getBBox: (this: Element) => Box;
    getComputedTextLength?: (this: Element) => number;
  };

  svgProto.getBBox = function getBBox(this: Element): Box {
    return computeBBox(this, 0);
  };
  svgProto.getComputedTextLength ??= function getComputedTextLength(this: Element): number {
    return (this.textContent ?? '').length * fontSizePx(this) * 0.6;
  };
}

function computeBBox(el: Element, depth: number): Box {
  // Recursion is bounded by realistic SVG nesting depth; this guard only
  // exists to fail safe (a zero box) instead of a stack overflow if a
  // future mermaid version produces a pathological/cyclic-looking tree.
  if (depth > 200) return { x: 0, y: 0, width: 0, height: 0 };

  switch (el.tagName) {
    case 'text':
    case 'tspan':
      return textBBox(el);
    case 'rect':
      return { x: numAttr(el, 'x'), y: numAttr(el, 'y'), width: numAttr(el, 'width'), height: numAttr(el, 'height') };
    case 'circle': {
      const r = numAttr(el, 'r');
      return { x: numAttr(el, 'cx') - r, y: numAttr(el, 'cy') - r, width: r * 2, height: r * 2 };
    }
    case 'ellipse': {
      const rx = numAttr(el, 'rx');
      const ry = numAttr(el, 'ry');
      return { x: numAttr(el, 'cx') - rx, y: numAttr(el, 'cy') - ry, width: rx * 2, height: ry * 2 };
    }
    case 'line':
      return unionOfPoints([
        [numAttr(el, 'x1'), numAttr(el, 'y1')],
        [numAttr(el, 'x2'), numAttr(el, 'y2')],
      ]);
    case 'polygon':
    case 'polyline':
      return unionOfPoints(parsePoints(el.getAttribute('points')));
    case 'path':
      return pathBBox(el);
    default:
      return containerBBox(el, depth);
  }
}

function containerBBox(el: Element, depth: number): Box {
  const children = Array.from(el.children);
  if (children.length === 0) return { x: 0, y: 0, width: 0, height: 0 };
  const boxes = children.map((child) => {
    const box = computeBBox(child, depth + 1);
    const { dx, dy } = parseTranslate(child);
    return { x: box.x + dx, y: box.y + dy, width: box.width, height: box.height };
  });
  return unionOfBoxes(boxes);
}

function textBBox(el: Element): Box {
  const text = el.textContent ?? '';
  const fontSize = fontSizePx(el);
  const width = Math.max(text.length * fontSize * 0.6, 1);
  const height = Math.max(fontSize * 1.3, 1);
  return { x: 0, y: -height * 0.8, width, height };
}

function pathBBox(el: Element): Box {
  const d = el.getAttribute('d') ?? '';
  const nums = (d.match(/-?\d+(\.\d+)?/g) ?? []).map(Number);
  const points: Array<[number, number]> = [];
  for (let i = 0; i + 1 < nums.length; i += 2) {
    points.push([nums[i], nums[i + 1]]);
  }
  return unionOfPoints(points);
}

function unionOfPoints(points: ReadonlyArray<readonly [number, number]>): Box {
  return unionOfBoxes(points.map(([x, y]) => ({ x, y, width: 0, height: 0 })));
}

function unionOfBoxes(boxes: ReadonlyArray<Box>): Box {
  const finite = boxes.filter((b) => Number.isFinite(b.x) && Number.isFinite(b.y) && Number.isFinite(b.width) && Number.isFinite(b.height));
  if (finite.length === 0) return { x: 0, y: 0, width: 0, height: 0 };
  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  for (const b of finite) {
    minX = Math.min(minX, b.x);
    minY = Math.min(minY, b.y);
    maxX = Math.max(maxX, b.x + b.width);
    maxY = Math.max(maxY, b.y + b.height);
  }
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}

function parsePoints(raw: string | null): Array<[number, number]> {
  const trimmed = (raw ?? '').trim();
  if (!trimmed) return [];
  return trimmed.split(/\s+/).map((pair) => {
    const [x, y] = pair.split(',').map(Number);
    return [x ?? 0, y ?? 0];
  });
}

function numAttr(el: Element, name: string, fallback = 0): number {
  const raw = el.getAttribute(name);
  if (raw == null) return fallback;
  const n = Number.parseFloat(raw);
  return Number.isNaN(n) ? fallback : n;
}

function fontSizePx(el: Element): number {
  const style = el.getAttribute('style') ?? '';
  const match = /font-size:\s*([\d.]+)px/.exec(style);
  return match ? Number.parseFloat(match[1]) : 16;
}

/** (dx, dy) offset from an element's own `transform="translate(x,y)"` attribute, defaulting to {0, 0}. */
function parseTranslate(el: Element): { dx: number; dy: number } {
  const transform = el.getAttribute('transform');
  if (!transform) return { dx: 0, dy: 0 };
  const match = /translate\(\s*(-?[\d.]+)[,\s]+(-?[\d.]+)/.exec(transform);
  if (!match) return { dx: 0, dy: 0 };
  return { dx: Number.parseFloat(match[1]), dy: Number.parseFloat(match[2]) };
}
