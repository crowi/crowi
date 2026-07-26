import { sanitizeSvg as sharedSanitizeSvg } from '@crowi/svg-sanitize';

/**
 * Thin adapter over `@crowi/svg-sanitize` (spec §9,
 * feature-plugin-renderer-mermaid Phase 3) — no sanitization logic of its
 * own. The previous implementation here was a from-scratch regex pass,
 * explicitly documented (in the version this replaces) as "not a
 * substitute for DOMPurify"; it has been deleted in favour of the shared
 * DOM-based sanitizer both `@crowi/plugin-renderer-mermaid` and this
 * package now converge on, so a future fix to the sanitization policy
 * only has to land once.
 *
 * PlantUML's policy allows a safe `https:` `href` to survive
 * (`allowSafeHref: true`) — the existing "preserves href to a safe URL"
 * contract (`index.test.ts`) — unlike Mermaid's strict policy
 * (`@crowi/plugin-renderer-mermaid/src/sanitize-svg.ts`,
 * `allowSafeHref: false`), which is consistent with layer 1 already
 * disabling Mermaid's own click callbacks. `javascript:` / `data:` /
 * protocol-relative URLs are always stripped by the shared sanitizer
 * regardless of this flag.
 */
export function sanitizeSvg(input: string): { ok: true; svg: string } | { ok: false; reason: string } {
  return sharedSanitizeSvg(input, { allowSafeHref: true });
}
