/**
 * Renderer-specific knobs for `sanitizeSvg`. The sanitizer itself is a
 * single shared implementation (`sanitize.ts`) — per-renderer differences
 * are expressed as parameters here, never as a second copy of the DOM
 * walk (spec §9: "実装自体をrenderer間で複製しない").
 */
export interface SanitizeSvgPolicy {
  /**
   * When `true`, `href` / `xlink:href` values pointing at an `https:`
   * URL are preserved (PlantUML's existing "preserves href to a safe
   * URL" behaviour, consumed starting Phase 3). When `false`, every
   * `href` / `xlink:href` is stripped unless it is a local fragment
   * reference (`#id`) — Mermaid's strict policy (spec §1 layer 1 already
   * disables Mermaid's own click callbacks, so no link should survive
   * either).
   *
   * Regardless of this flag, `javascript:`, `data:`, and
   * protocol-relative (`//host/...`) URLs are ALWAYS stripped — no
   * policy may re-allow those.
   */
  allowSafeHref: boolean;
}
