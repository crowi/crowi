/**
 * (dx, dy) offset from an element's own `transform="translate(x,y)"`
 * attribute, defaulting to {0, 0} when absent or unparseable. Shared by
 * `dom-env.ts`'s getBBox container-union walk and the Phase 0 fixtures
 * (`__fixtures__/svg-inspect.ts`'s label-position ancestor walk).
 */
export function parseTranslate(el: Element): { dx: number; dy: number } {
  const transform = el.getAttribute('transform');
  if (!transform) return { dx: 0, dy: 0 };
  const match = /translate\(\s*(-?[\d.]+)[,\s]+(-?[\d.]+)/.exec(transform);
  if (!match) return { dx: 0, dy: 0 };
  return { dx: Number.parseFloat(match[1]), dy: Number.parseFloat(match[2]) };
}
