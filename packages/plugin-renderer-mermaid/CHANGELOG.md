# @crowi/plugin-renderer-mermaid

## 0.1.0-alpha.5

### Patch Changes

- 82a928d: Bump `mermaid` to 11.16.1, which closes five advisories against 11.16.0 (GHSA reports #686–#690). Mermaid runs in the reader's browser to draw diagrams from page content, so anything it mishandles is reachable from a page body — this is the one runtime dependency among the batch, and the reason it is worth a release rather than waiting. The declared range moves from `^11.16.0` to `^11.16.1` so a fresh install cannot resolve back to the affected version.
- Updated dependencies [9a06104]
  - @crowi/plugin-api@1.0.0-alpha.7

## 0.1.0-alpha.4

### Minor Changes

- 7a7394f: Make `renderedAst` a client-agnostic typed contract (RFC-0023). Renderer producers (shiki, KaTeX, Mermaid, PlantUML, link cards, placeholders) now stamp typed sidecar data onto the byte-identical `html` nodes they already emit, and clients that declare `X-Crowi-Ast-Version: 1` receive a validated `{astVersion, root}` envelope in which those nodes are projected into typed nodes (`code` with themed tokens, `math`/`inlineMath` with TeX source, `crowiDiagram` with intrinsic dimensions, `crowiLinkCard`, `crowiPlaceholder`) — the foundation for native (non-HTML) rendering such as the iOS app. Requests without the header — including the web, permanently — keep receiving the stored bare mdast Root verbatim, so existing clients and open tabs are unaffected. Responses now also carry `renderedAstArtifactKey`, which fixes a web bug where a pending diagram that finished rendering (or a freshness-mismatch recompute) was not re-drawn on refetch because the render memo only keyed on the revision id. Operators: this release bumps the renderer pipeline to 1.0.0 and removes the missing-version freshness special case — run the new `crowi-admin rebuild rendered-ast` (real writes) immediately after deploying, and use `--dry-run` only before that; see the admin guide's "rebuild rendered-ast" section for the rollout and completion procedure.

### Patch Changes

- 7688188: `@crowi/plugin-api` now re-exports `sanitizeSvg` and `extractSvgDimensions`, so a plugin that needs SVG sanitization gets it from the SDK rather than from a package of its own. This also fixes a release-blocking defect: `@crowi/api` had picked up a runtime dependency on the private, never-published `@crowi/svg-sanitize`, which would have published an `@crowi/api` whose declared dependency does not exist on npm — core builds with `tsc` and cannot inline a workspace package itself, so it now takes the sanitizer from the SDK too. The SDK is the single place the private package is inlined, which also means a sanitizer change no longer obliges re-publishing every renderer plugin. `@xmldom/xmldom` becomes a declared dependency of `@crowi/plugin-api` (it is deliberately not inlined, so operators can still address a CVE in it through their own lockfile).
- Updated dependencies [7a7394f]
- Updated dependencies [7688188]
  - @crowi/plugin-api@1.0.0-alpha.5

## 0.1.0-alpha.3

### Patch Changes

- b4a6d8e: Fix Mermaid diagrams rendering as invisible (0×0) on both the saved page view and the live editor preview.

  Three independent root causes, all fixed:

  - Mermaid's generated SVG declares `width="100%"` with no absolute height (only a `viewBox`), giving the base64-embedded `<img>` no resolvable intrinsic size once placed inside the diagram wrapper's `inline-block` element (whose own width is itself `auto`, sized from its content) — the two collapsed to 0×0. The renderer now derives `width`/`height` attributes from the sanitized SVG's own `viewBox` and adds them to the emitted `<img>` tag.
  - The page view and editor preview's `img:` markdown component overrides were both dropping any `width`/`height` a renderer plugin declared instead of forwarding them to the rendered `<img>` element, silently discarding the fix above.
  - Gantt charts specifically rendered with a corrupted, negative-width layout (not just invisible) — traced to Mermaid's Gantt renderer falling back to a 0px layout width because jsdom's `offsetWidth` (used by this plugin's isolated render-worker) always returns `0` rather than `undefined`, so Mermaid's own `undefined`-only fallback never activated. The render worker now sets Mermaid's `gantt.useWidth` config explicitly to sidestep that measurement entirely.

  Existing pages with a Mermaid diagram saved before this fix keep serving their previously-rendered (invisible) markup until next edited and saved — this matches how this renderer's cache versioning has always behaved for schema changes.

## 0.1.0-alpha.2

### Minor Changes

- d680c0c: Add server-side Mermaid diagram rendering (RFC-0002 Phase 6.1).

  New `@crowi/plugin-renderer-mermaid` plugin: ` ```mermaid ` fenced code blocks are rendered entirely server-side in an isolated, network-denied child process (no client-side Mermaid JS ever ships to the browser) and embedded as a sanitized, base64-encoded SVG `<img>`. Supports flowchart, sequence, class, state, ER, journey, pie, and git-graph diagrams, with a shared, independently-tested DOM-based SVG sanitizer (new, private `@crowi/svg-sanitize` package) that also replaces `@crowi/plugin-renderer-plantuml`'s previous regex-only sanitizer. No operator configuration is required, and existing pages keep rendering their `mermaid` fences as plain code blocks until the author explicitly re-saves them.

  The editor's live preview now renders Mermaid diagrams as you type, not just after saving: a new `previewPolicy` opt-in on `CodeBlockRenderer` lets a renderer participate in non-persistent preview rendering (page-less, no cache writes), gated by the same per-user admission-control concurrency limits and priority scheduling used for saved-page rendering, plus a per-user rate limit on the preview endpoint and proper request cancellation when a newer keystroke supersedes an in-flight preview.

  The page-view diagram wrapper (click-to-enlarge, cap-to-width, dark-mode-neutral surface) is generalized from PlantUML-only to any diagram renderer, so Mermaid diagrams get the same affordance PlantUML diagrams already had.

### Patch Changes

- 1825a1a: The shared SVG sanitizer moved from the published `@crowi/plugin-renderer-svg-sanitize` package to a private, internal-only `@crowi/svg-sanitize` package that is now bundled directly into each renderer's `dist` at build time instead of being installed as a runtime dependency. Sanitization behaviour is unchanged; only the dependency graph of the published package changed (the workspace dependency moved to `devDependencies`, and `@xmldom/xmldom` is now declared directly as a `dependencies` entry of each renderer instead of being resolved transitively).
- Updated dependencies [df1ce77]
- Updated dependencies [05648c0]
- Updated dependencies [d680c0c]
- Updated dependencies [a32204f]
- Updated dependencies [b0e2c76]
  - @crowi/plugin-api@1.0.0-alpha.4
