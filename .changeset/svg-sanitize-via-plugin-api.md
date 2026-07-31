---
'@crowi/plugin-api': minor
'@crowi/api': patch
'@crowi/plugin-renderer-mermaid': patch
'@crowi/plugin-renderer-plantuml': patch
---

`@crowi/plugin-api` now re-exports `sanitizeSvg` and `extractSvgDimensions`, so a plugin that needs SVG sanitization gets it from the SDK rather than from a package of its own. This also fixes a release-blocking defect: `@crowi/api` had picked up a runtime dependency on the private, never-published `@crowi/svg-sanitize`, which would have published an `@crowi/api` whose declared dependency does not exist on npm — core builds with `tsc` and cannot inline a workspace package itself, so it now takes the sanitizer from the SDK too. The SDK is the single place the private package is inlined, which also means a sanitizer change no longer obliges re-publishing every renderer plugin. `@xmldom/xmldom` becomes a declared dependency of `@crowi/plugin-api` (it is deliberately not inlined, so operators can still address a CVE in it through their own lockfile).
