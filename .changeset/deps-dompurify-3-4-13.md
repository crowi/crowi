---
"@crowi/plugin-renderer-mermaid": patch
---

Move `dompurify` to 3.4.13, which closes GHSA report #693. It arrives under `mermaid`, which uses it to sanitize the SVG it produces from diagram source — so it sits directly on the path that turns page content into markup the reader's browser renders. `mermaid@11.16.1` already declares `^3.3.3`, so this is a lockfile move with no override and no manifest change; there is no newer `mermaid` to take instead.
