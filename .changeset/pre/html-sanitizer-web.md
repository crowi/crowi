---
"@crowi/api": patch
"@crowi/web": patch
"@crowi/api-contract": minor
---

The web app now always renders page, history and preview HTML through a strict allow-list sanitizer, so arbitrary HTML and CSS written in a page body (scripts, event handlers, `style`, custom `class`, unknown attributes) no longer take effect, while generated output such as code highlighting, math, diagrams, link cards and URL expansion keeps its current look, and the stored page body is never changed. The renderer stamps generated HTML with an origin mark and its pipeline version moves to 2.0.0, so existing pages are recomputed on read. Markdown and HTML links with `javascript:`, `vbscript:` or `data:` URLs lose their href and show their label as plain text while ordinary links such as `tel:`, `file://` and `slack://` are kept, and images with a non-raster `data:` URL (such as SVG) or a disallowed scheme are shown as their alt text. `@crowi/api-contract` gains the shared `html-sanitizer` subpath.
