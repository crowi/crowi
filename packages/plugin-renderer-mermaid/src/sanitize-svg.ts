import { sanitizeSvg as sharedSanitizeSvg } from '@crowi/plugin-api';

/**
 * Thin adapter over `@crowi/svg-sanitize` (spec §1 / §9) — no
 * sanitization logic of its own. Mermaid's policy is strict:
 * `allowSafeHref: false` unconditionally strips every `href` /
 * `xlink:href` except local fragment references (`#id`), consistent
 * with §1 layer 1 already disabling Mermaid's own click callbacks —
 * nothing in a Mermaid diagram is supposed to be a live link.
 */
export function sanitizeMermaidSvg(svg: string): { ok: true; svg: string } | { ok: false } {
  const result = sharedSanitizeSvg(svg, { allowSafeHref: false });
  if (!result.ok) return { ok: false };
  return { ok: true, svg: result.svg };
}
