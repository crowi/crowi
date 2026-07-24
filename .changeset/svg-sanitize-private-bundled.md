---
"@crowi/plugin-renderer-mermaid": patch
"@crowi/plugin-renderer-plantuml": patch
---

The shared SVG sanitizer moved from the published `@crowi/plugin-renderer-svg-sanitize` package to a private, internal-only `@crowi/svg-sanitize` package that is now bundled directly into each renderer's `dist` at build time instead of being installed as a runtime dependency. Sanitization behaviour is unchanged; only the dependency graph of the published package changed (the workspace dependency moved to `devDependencies`, and `@xmldom/xmldom` is now declared directly as a `dependencies` entry of each renderer instead of being resolved transitively).
