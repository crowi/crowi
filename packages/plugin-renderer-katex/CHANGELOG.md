# @crowi/plugin-renderer-katex

## 1.0.0-alpha.2

### Major Changes

- af906f7: BREAKING: the KaTeX stylesheet manifest path (`STYLESHEET_MANIFEST_PATH`, what `registry.addStylesheet(...)` advertises and what `RendererStylesheets` renders into a `<link href>`) moves from `/api/v2/plugins/@crowi/plugin-renderer-katex/katex.min.css` to `/api/plugins/@crowi/plugin-renderer-katex/katex.min.css`, following the api-wide `/api/v2` → `/api` prefix cutover. Bumping this package alone is not required before the cutover — `@crowi/api`'s `renderer/registry.ts` validator dual-accepts both prefixes for a transitional period and normalizes a legacy-prefixed path to canonical before publishing it, so an unbumped install keeps rendering KaTeX correctly. Bump to pick up the canonical prefix once your runner has also upgraded `@crowi/api` past the cutover.

### Minor Changes

- 7a7394f: Make `renderedAst` a client-agnostic typed contract (RFC-0023). Renderer producers (shiki, KaTeX, Mermaid, PlantUML, link cards, placeholders) now stamp typed sidecar data onto the byte-identical `html` nodes they already emit, and clients that declare `X-Crowi-Ast-Version: 1` receive a validated `{astVersion, root}` envelope in which those nodes are projected into typed nodes (`code` with themed tokens, `math`/`inlineMath` with TeX source, `crowiDiagram` with intrinsic dimensions, `crowiLinkCard`, `crowiPlaceholder`) — the foundation for native (non-HTML) rendering such as the iOS app. Requests without the header — including the web, permanently — keep receiving the stored bare mdast Root verbatim, so existing clients and open tabs are unaffected. Responses now also carry `renderedAstArtifactKey`, which fixes a web bug where a pending diagram that finished rendering (or a freshness-mismatch recompute) was not re-drawn on refetch because the render memo only keyed on the revision id. Operators: this release bumps the renderer pipeline to 1.0.0 and removes the missing-version freshness special case — run the new `crowi-admin rebuild rendered-ast` (real writes) immediately after deploying, and use `--dry-run` only before that; see the admin guide's "rebuild rendered-ast" section for the rollout and completion procedure.

### Patch Changes

- Updated dependencies [7a7394f]
- Updated dependencies [7688188]
  - @crowi/plugin-api@1.0.0-alpha.5

## 0.1.0-alpha.1

### Patch Changes

- Updated dependencies [336eec1]
- Updated dependencies [8ff0e64]
- Updated dependencies [b20ff59]
- Updated dependencies [d611836]
- Updated dependencies [5e857f6]
  - @crowi/plugin-api@1.0.0-alpha.3

## 0.1.0-alpha.0

### Minor Changes

- a52d03f: Initial publish preparation: monorepo restructure complete (RFC-0002 →
  feature-monorepo-packages-restructure). All packages now use
  workspace: protocol internally, peerDependencies for plugin boundaries,
  shared @crowi/tsconfig presets, and a publish-ready layout under
  packages/\*.

### Patch Changes

- Updated dependencies [a52d03f]
- Updated dependencies [966d133]
- Updated dependencies [7f77407]
  - @crowi/plugin-api@0.1.0-alpha.0
