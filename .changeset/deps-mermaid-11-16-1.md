---
"@crowi/plugin-renderer-mermaid": patch
---

Bump `mermaid` to 11.16.1, which closes five advisories against 11.16.0 (GHSA reports #686–#690). Mermaid runs in the reader's browser to draw diagrams from page content, so anything it mishandles is reachable from a page body — this is the one runtime dependency among the batch, and the reason it is worth a release rather than waiting. The declared range moves from `^11.16.0` to `^11.16.1` so a fresh install cannot resolve back to the affected version.
