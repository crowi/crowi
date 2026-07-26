/**
 * Renderer pipeline version stamp.
 *
 * Written onto `Revision.rendererVersion` at save time so the read
 * path can detect when a stored `renderedAst` was produced by an
 * older pipeline configuration than the running server.
 *
 * Bump policy:
 *   - **major**: backwards-incompatible AST shape change (e.g. a node
 *     type renamed). Stored ASTs from older majors are no longer
 *     renderable without rebuild.
 *   - **minor**: new bundled plugin / shiki language set extension /
 *     transform plugin added. Older ASTs render fine but don't get the
 *     new behaviour until rebuilt.
 *   - **patch**: bug fix in a transform that doesn't change AST shape.
 *     Re-rendering yields the corrected output.
 *
 * Versioning aligns with RFC-0002 phase progression at major.minor:
 *   - 0.3.x  Phase 3 (SSR + shiki)
 *   - 0.4.x  Phase 4 (cache contract + reservation + dispatch)
 *   - 0.5.x  Phase 5 (crowi-legacy + wikilink migrator)
 *   - 0.6.x  Phase 6 (plantuml + emoji + katex + addCodeBlockRenderer)
 *   - 0.7.x  dark mode (shiki dual-theme CSS-variable output)
 *   - 0.8.x  RFC-0015 image display attributes (`remarkImageAttrs`
 *     core transform — bundled plugin addition, minor bump)
 *   - 0.9.x  feature-renderer-plugin-boundary Phase 3 — emoji becomes
 *     a hard-coded post-remarkBreaks core transform and link-card
 *     becomes a core-reserved `card` embed tag (both were previously
 *     registry-registered plugins); new-bundled-transform minor bump
 *     per this constant's own policy above. (Phase 2's KaTeX/PlantUML/
 *     Mermaid data-contract + cacheVersion work deliberately did NOT
 *     bump this — see `page-response.test.ts`'s pinned assertion.)
 *
 * Until `renderer:rebuild` ships (deferred to RFC-0008), version
 * mismatch is informational only — the read path's parse-on-read
 * fallback handles missing or stale `renderedAst` transparently at
 * a per-request CPU cost.
 */
export const RENDERER_PIPELINE_VERSION = '0.9.0';
