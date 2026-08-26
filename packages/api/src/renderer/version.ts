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
 *   - 0.10.x feature-page-link-space-paths Phase 2 — raw-space link
 *     recovery (`renderer/core/raw-space-links.ts`) added as a new
 *     bundled transform (`buildCorePlugins`); new-bundled-transform
 *     minor bump per this constant's own policy above.
 *   - 1.0.0  RFC-0023 (client-agnostic renderedAst) — producers stamp
 *     typed sidecars (`data.crowiCode` / `crowiMath` / `crowiDiagram` /
 *     `crowiLinkCard` / `crowiPlaceholder`) onto their `html` nodes.
 *     The html bytes and node types are unchanged, but pre-1.0 ASTs
 *     lack the sidecars the `X-Crowi-Ast-Version: 1` projection needs,
 *     so they must be invalidated wholesale: MAJOR bump. Alongside this
 *     bump the read path's missing-`rendererVersion` freshness special
 *     case is removed (`util/page-response.ts`) — every stale/legacy
 *     revision recomputes per read until `rebuild rendered-ast`
 *     (`util/rebuild-rendered-ast.ts`) backfills it, so the rollout
 *     procedure REQUIRES running that rebuild (real-write mode)
 *     immediately after deploying this version.
 *   - 1.1.0  feature-renderer-frontmatter — a document-leading YAML
 *     frontmatter block is parsed (`remarkFrontmatter` parser
 *     extension) and replaced by a new bundled transform
 *     (`core/frontmatter.ts`'s `makeFrontmatterPlugin`) with either a
 *     `crowiFrontmatter` node or a `code` (`lang: 'yaml'`) fallback,
 *     instead of rendering as a `thematicBreak` + paragraph; new-
 *     bundled-transform minor bump per this constant's own policy
 *     above. Same rollout as every bump since 1.0.0: existing pages
 *     recompute per read (`util/page-response.ts`) until saved or
 *     `rebuild rendered-ast` backfills the DB copy, so the new
 *     rendering shows up on next view, not next save.
 *   - 1.2.0  GitHub Alerts — a document-root block quote opening with
 *     a GitHub Alerts marker (`> [!NOTE]` …) is retyped to
 *     `crowiAlert` by a new bundled transform
 *     (`core/github-alerts.ts`'s `makeGithubAlertsPlugin`); new-
 *     bundled-transform minor bump per this constant's own policy
 *     above. Rollout is the ordinary one: a stored 1.1.0 AST recomputes
 *     per read (`util/page-response.ts`, no write-back) so the callout
 *     appears on next view, and `rebuild rendered-ast` backfills the DB
 *     copy in bulk whenever an operator chooses to. During a normal
 *     rolling deployment old and new replicas serve the same revision
 *     differently for as long as both are up — an accepted, transient
 *     difference (the stored bytes are never contested, both sides only
 *     ever recompute for their own response), NOT something a dedicated
 *     drain / traffic-isolation gate exists for.
 *   - 1.3.0  feature-renderer-break-normalization — an attribute-less
 *     `<br>` in any spelling CommonMark accepts (`<br>` / `<br >` /
 *     `<br/>` / `<br />` / `<br\t/>` — the whitespace run before the
 *     optional slash is unbounded) as an `html` node inside an uncontaminated
 *     `paragraph` / `heading` / `tableCell` phrasing subtree is
 *     normalized to a canonical mdast `break` by a new bundled
 *     transform (`core/break-normalization.ts`'s
 *     `remarkNormalizeHtmlBreaks`); new-bundled-transform minor bump
 *     per this constant's own policy above. Rollout is the ordinary
 *     one: a stored 1.2.0 AST recomputes per read (`util/page-
 *     response.ts`, no write-back) so non-web clients stop showing a
 *     placeholder for the normalized line break on next view, and
 *     `rebuild rendered-ast` backfills the DB copy in bulk whenever an
 *     operator chooses to — but that command only ever collects each
 *     page's CURRENT revision (`util/rebuild-rendered-ast.ts`'s
 *     `collectPrefilteredTargets`), so a stale HISTORY revision keeps
 *     recomputing on every read of `GET /pages/revisions/:id`
 *     indefinitely; that is a per-read cost, not a correctness gap.
 */
export const RENDERER_PIPELINE_VERSION = '1.3.0';
