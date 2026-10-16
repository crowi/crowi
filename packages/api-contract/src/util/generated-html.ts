/**
 * Provenance mark for `html` nodes the renderer pipeline synthesizes itself
 * (syntax highlight, KaTeX/diagram/card output, URL expansion). An author's
 * raw HTML never carries it, so the Web renderer can keep the two apart:
 * generated HTML is composed as-is, author HTML goes through the strict
 * allow-list. Not a signature — the AST is produced server-side from the
 * page body, which is the trust boundary.
 */
export type GeneratedHtmlOrigin = 1;

export function isGeneratedHtmlOrigin(value: unknown): value is GeneratedHtmlOrigin {
  return value === 1;
}

/** Merges `g: 1` into `node.data` (keeping existing sidecars) and returns the same node. */
export function markGeneratedHtml<T extends { data?: object }>(node: T): T {
  (node as { data?: object }).data = { ...node.data, g: 1 satisfies GeneratedHtmlOrigin };
  return node;
}
