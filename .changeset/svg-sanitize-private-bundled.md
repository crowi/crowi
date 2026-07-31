---
"@crowi/plugin-renderer-mermaid": patch
"@crowi/plugin-renderer-plantuml": patch
---

The shared SVG sanitizer moved from the published `@crowi/plugin-renderer-svg-sanitize` package to a private, internal-only `@crowi/svg-sanitize` package, which each renderer inlined into its own `dist` at build time. Each renderer now reaches it through `@crowi/plugin-api` instead, which re-exports `sanitizeSvg` / `extractSvgDimensions` and is the single place the private package is inlined. Sanitization behaviour is unchanged; only the dependency graph and packaging of the published renderers changed.
