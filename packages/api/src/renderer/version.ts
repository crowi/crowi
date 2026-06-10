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
 *
 * Until `renderer:rebuild` ships (deferred to RFC-0008), version
 * mismatch is informational only — the read path's parse-on-read
 * fallback handles missing or stale `renderedAst` transparently at
 * a per-request CPU cost.
 */
export const RENDERER_PIPELINE_VERSION = '0.7.0';
