---
'@crowi/api': patch
---

Fix the portal document being stuck on "Rendering…" in the page list, even after publishing. `listPages` projected the portal with the lean `pageToResponse` (no `renderedAst`), but the web client renders the portal as a full page and needs the AST. The portal response now emits `renderedAst` and runs the same on-the-fly fallback as the page detail endpoint, so legacy / renderer-version-mismatched revisions render too.
