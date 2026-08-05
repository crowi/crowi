# @crowi/plugin-renderer-plantuml

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

- 1825a1a: The shared SVG sanitizer moved from the published `@crowi/plugin-renderer-svg-sanitize` package to a private, internal-only `@crowi/svg-sanitize` package that is now bundled directly into each renderer's `dist` at build time instead of being installed as a runtime dependency. Sanitization behaviour is unchanged; only the dependency graph of the published package changed (the workspace dependency moved to `devDependencies`, and `@xmldom/xmldom` is now declared directly as a `dependencies` entry of each renderer instead of being resolved transitively).
- Updated dependencies [df1ce77]
- Updated dependencies [05648c0]
- Updated dependencies [d680c0c]
- Updated dependencies [a32204f]
- Updated dependencies [b0e2c76]
  - @crowi/plugin-api@1.0.0-alpha.4

## 0.1.0-alpha.2

### Patch Changes

- Updated dependencies [336eec1]
- Updated dependencies [8ff0e64]
- Updated dependencies [b20ff59]
- Updated dependencies [d611836]
- Updated dependencies [5e857f6]
  - @crowi/plugin-api@1.0.0-alpha.3

## 0.1.0-alpha.1

### Patch Changes

- ff63cd1: Declare an explicit `zod` peer dependency range (`^4`) instead of `catalog:`. pnpm does not resolve the `catalog:` protocol inside `peerDependencies` during a workspace/source install, so building Crowi from source emitted a spurious `unmet peer zod@catalog:` warning for every plugin. Published packages were already correct (pnpm rewrites `catalog:` to a concrete range on publish), so npm consumers were unaffected — this only silences the noisy source/Docker-build install. Declaring `^4` also more honestly states that the plugins are compatible with any zod 4.x the host application provides.
- Updated dependencies [ff63cd1]
  - @crowi/plugin-api@0.1.0-alpha.1

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
